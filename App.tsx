
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { INITIAL_GLOSSARY } from './constants';
import { TranslationItem, LocalizationStats, TranslationMemory, FileEntry, ToastMessage } from './types';
import { GeminiTranslator } from './services/geminiService';
import { DeepLTranslator } from './services/deeplService';
import GlossaryManager from './components/GlossaryManager';

const WAIT_TIME_MS = 4000; 
const RATE_LIMIT_WAIT_MS = 65000;
const MAX_FILES = 50;
const STORAGE_KEY_DATA = 'linguist_project_data';
const STORAGE_KEY_TM = 'linguist_tm';

const parseCSV = (text: string): string[][] => {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  for (let i = 0; i < cleanText.length; i++) {
    const char = cleanText[i];
    const nextChar = cleanText[i + 1];
    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentCell);
        currentCell = '';
      } else if (char === '\n') {
        currentRow.push(currentCell);
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
  }
  if (currentCell || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }
  return rows;
};

const App: React.FC = () => {
  const [glossary, setGlossary] = useState<Record<string, string>>(INITIAL_GLOSSARY);
  const [fileQueue, setFileQueue] = useState<FileEntry[]>([]);
  const [currentItems, setCurrentItems] = useState<TranslationItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentFileIndex, setCurrentFileIndex] = useState(-1);
  const [isDragging, setIsDragging] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  
  const [tm, setTm] = useState<TranslationMemory>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_TM);
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  
  const [batchSize, setBatchSize] = useState<number>(50);
  const [serviceType, setServiceType] = useState<'gemini' | 'deepl'>('gemini');
  const [geminiModel, setGeminiModel] = useState<string>(() => localStorage.getItem('gemini_selected_model') || 'gemini-3-pro-preview');

  // Keys State
  const [geminiKeysInput, setGeminiKeysInput] = useState<string>(() => localStorage.getItem('gemini_api_key') || '');
  const [deepLKeyInput, setDeepLKeyInput] = useState<string>(() => localStorage.getItem('deepl_api_key') || '');

  const geminiKeys = useMemo(() => {
    return geminiKeysInput.split(',').map(k => k.trim()).filter(k => k.length > 0);
  }, [geminiKeysInput]);

  const activeKeyIndexRef = useRef(0);

  const [eventStats, setEventStats] = useState({
    cachedStrings: 0,
    apiCalls: 0,
    errors: 0
  });

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  
  const fileResultsRef = useRef<Record<string, TranslationItem[]>>({});
  const geminiTranslatorRef = useRef<GeminiTranslator | null>(null);
  const deepLTranslatorRef = useRef<DeepLTranslator | null>(null);
  const shouldStopRef = useRef(false);

  useEffect(() => {
    const savedData = localStorage.getItem(STORAGE_KEY_DATA);
    if (savedData) {
      try {
        const parsed = JSON.parse(savedData);
        if (parsed.queue && parsed.results) {
          setFileQueue(parsed.queue);
          fileResultsRef.current = parsed.results;
          if (parsed.currentIndex >= 0 && parsed.queue[parsed.currentIndex]) {
            setCurrentFileIndex(parsed.currentIndex);
            const fileName = parsed.queue[parsed.currentIndex].name;
            if (parsed.results[fileName]) {
              setCurrentItems(parsed.results[fileName]);
            }
          }
          addToast('Проєкт відновлено', 'info');
        }
      } catch (e) { console.error(e); }
    }
  }, []);

  const saveProjectState = useCallback(() => {
    if (isProcessing) return;
    const queueToSave = fileQueue.map(({ rawFile, ...rest }) => rest);
    const dataToSave = {
        queue: queueToSave,
        results: fileResultsRef.current,
        currentIndex: currentFileIndex
    };
    try { localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(dataToSave)); } catch (e) { console.warn(e); }
  }, [fileQueue, currentFileIndex, isProcessing]);

  useEffect(() => {
    const timeout = setTimeout(saveProjectState, 1000);
    return () => clearTimeout(timeout);
  }, [saveProjectState, currentItems]);

  const stats = useMemo<LocalizationStats>(() => {
    const totalFiles = fileQueue.length;
    const completedFiles = fileQueue.filter(f => f.status === 'done').length;
    const totalStrings = fileQueue.reduce((acc, f) => acc + (f.totalItems || 0), 0);
    const completedStrings = fileQueue.reduce((acc, f) => acc + (f.completedItems || 0), 0);
    return {
        totalFiles, completedFiles, totalStrings, completedStrings,
        cachedStrings: eventStats.cachedStrings, apiCalls: eventStats.apiCalls, errors: eventStats.errors
    };
  }, [fileQueue, eventStats]);

  const sessionPercentage = useMemo(() => {
    if (stats.totalStrings === 0) return 0;
    return Math.min(100, Math.round((stats.completedStrings / stats.totalStrings) * 100));
  }, [stats.completedStrings, stats.totalStrings]);

  useEffect(() => {
    geminiTranslatorRef.current = new GeminiTranslator();
    deepLTranslatorRef.current = new DeepLTranslator();
  }, []);

  useEffect(() => {
    if (cooldown > 0) {
      const timer = setInterval(() => {
        setCooldown(prev => prev <= 1 ? (clearInterval(timer), 0) : prev - 1);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [cooldown]);

  const addToast = (message: string, type: ToastMessage['type'] = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  const handleSaveConfig = () => {
    localStorage.setItem('gemini_selected_model', geminiModel);
    if (serviceType === 'deepl') {
        localStorage.setItem('deepl_api_key', deepLKeyInput);
    } else {
        localStorage.setItem('gemini_api_key', geminiKeysInput);
    }
    addToast("Налаштування збережено");
  };

  const resetProject = () => {
      if (confirm("Видалити прогрес? Глосарій та TM залишаться.")) {
          setFileQueue([]);
          setCurrentItems([]);
          setCurrentFileIndex(-1);
          fileResultsRef.current = {};
          localStorage.removeItem(STORAGE_KEY_DATA);
          addToast("Проєкт очищено", "info");
      }
  };

  // Updated to parse files immediately to calculate total stats
  const addFilesToQueue = async (files: File[]) => {
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
    if (csvFiles.length === 0) { setErrorMsg("Лише CSV файли."); return; }
    
    addToast(`Аналіз ${csvFiles.length} файлів...`, 'info');

    const newFiles: FileEntry[] = [];

    for (const f of csvFiles) {
        try {
            const text = await f.text();
            const rows = parseCSV(text);
            // Assuming header exists, subtract 1. If length is 0, total is 0.
            const totalItems = Math.max(0, rows.length - 1);
            
            newFiles.push({
                name: f.name,
                status: 'pending',
                progress: 0,
                totalItems: totalItems,
                completedItems: 0,
                rawFile: f
            });
        } catch (e) {
            console.error(`Error reading file ${f.name}`, e);
            addToast(`Помилка читання ${f.name}`, 'error');
        }
    }

    setFileQueue(prev => [...prev, ...newFiles]);
    addToast(`Додано ${newFiles.length} файл(ів)`);
  };

  const deleteFile = (index: number) => {
    if (index === currentFileIndex && isProcessing) { addToast("Файл в роботі", "error"); return; }
    const fileName = fileQueue[index].name;
    delete fileResultsRef.current[fileName];
    const newQueue = fileQueue.filter((_, i) => i !== index);
    setFileQueue(newQueue);
    if (index === currentFileIndex) { setCurrentFileIndex(-1); setCurrentItems([]); }
    else if (index < currentFileIndex) setCurrentFileIndex(currentFileIndex - 1);
  };

  const handleRetryFile = (index: number) => {
    if (isProcessing) return;
    setFileQueue(prev => prev.map((f, i) => i === index ? { ...f, status: 'pending' } : f));
    const fileName = fileQueue[index].name;
    if (fileResultsRef.current[fileName]) {
        fileResultsRef.current[fileName] = fileResultsRef.current[fileName].map(item => 
            (item.status === 'failed' || !item.target) ? { ...item, status: 'pending' } : item
        );
        if (index === currentFileIndex) setCurrentItems(fileResultsRef.current[fileName]);
    }
  };

  const processFileMetadata = async (fileEntry: FileEntry) => {
    if (fileResultsRef.current[fileEntry.name]) return fileResultsRef.current[fileEntry.name];
    if (fileEntry.rawFile) {
        return new Promise<TranslationItem[]>((resolve) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            const rows = parseCSV(event.target?.result as string);
            if (rows.length === 0) { resolve([]); return; }
            const header = rows[0];
            const keyIdx = header.findIndex(h => h.trim().toLowerCase() === 'key');
            const sourceIdx = header.findIndex(h => h.trim().toLowerCase() === 'source');
            const targetIdx = header.findIndex(h => h.trim().toLowerCase() === 'target');
            const items: TranslationItem[] = [];
            for (let i = 1; i < rows.length; i++) {
              const cols = rows[i];
              if (cols.length === 1 && !cols[0].trim()) continue;
              const source = sourceIdx !== -1 ? cols[sourceIdx]?.trim() : '';
              const key = (keyIdx !== -1 ? cols[keyIdx]?.trim() : '') || `row_${i}`;
              const target = targetIdx !== -1 ? cols[targetIdx]?.trim() : undefined;
              if (source) items.push({ id: i, key, source, target, status: target ? 'done' : 'pending', fileName: fileEntry.name });
            }
            resolve(items);
          };
          reader.readAsText(fileEntry.rawFile!);
        });
    }
    return [];
  };

  const handleManualEdit = (id: string | number, newTarget: string) => {
    setCurrentItems(prev => prev.map(item => item.id === id ? { ...item, target: newTarget, isEdited: true } : item));
    const fileName = fileQueue[currentFileIndex]?.name;
    if (fileName && fileResultsRef.current[fileName]) {
        fileResultsRef.current[fileName] = fileResultsRef.current[fileName].map(item => 
            item.id === id ? { ...item, target: newTarget, isEdited: true } : item
        );
    }
  };

  const reValidateItem = async (id: string | number) => {
    const item = currentItems.find(i => i.id === id);
    if (!item) return;
    setCurrentItems(prev => prev.map(i => i.id === id ? { ...i, status: 'processing' } : i));
    try {
      let results;
      if (serviceType === 'gemini') {
        const key = geminiKeys.length > 0 ? geminiKeys[activeKeyIndexRef.current % geminiKeys.length] : undefined;
        results = await geminiTranslatorRef.current?.translateBatch([item], JSON.stringify(glossary), geminiModel, key);
      } else {
        results = await deepLTranslatorRef.current?.translateBatch([item], deepLKeyInput, JSON.stringify(glossary));
      }
      if (results && results[0]) {
        const result = results[0];
        setCurrentItems(prev => {
            const updated = prev.map(i => i.id === id ? { ...i, target: result.translation, status: 'done' as const, confidence: result.confidence, validationNote: result.critique, isEdited: false } : i);
            if (currentFileIndex >= 0) fileResultsRef.current[fileQueue[currentFileIndex].name] = updated;
            return updated;
        });
        const newTm = { ...tm, [item.source.trim()]: result.translation };
        setTm(newTm);
        localStorage.setItem(STORAGE_KEY_TM, JSON.stringify(newTm));
        addToast("Оновлено");
      }
    } catch (err: any) { setCurrentItems(prev => prev.map(i => i.id === id ? { ...i, status: 'failed' } : i)); }
  };

  const startBatchProcess = async () => {
    if (fileQueue.length === 0 || isProcessing) return;
    
    // Check keys
    if (serviceType === 'gemini' && geminiKeys.length === 0) {
        // Fallback or warning
    }

    shouldStopRef.current = false;
    setIsProcessing(true);
    setErrorMsg(null);
    let tempTm = { ...tm };
    
    for (let fIdx = 0; fIdx < fileQueue.length; fIdx++) {
      if (shouldStopRef.current) break;
      if (fileQueue[fIdx].status === 'done') continue;
      const fileEntry = fileQueue[fIdx];
      const items = await processFileMetadata(fileEntry);
      setCurrentFileIndex(fIdx);
      setCurrentItems(items);
      let completedInFile = items.filter(i => i.status === 'done' || i.status === 'cached').length;
      setFileQueue(prev => prev.map((f, i) => i === fIdx ? { ...f, status: 'processing', totalItems: items.length, completedItems: completedInFile } : f));
      const updatedWithCache = items.map(item => {
        if (item.status === 'done' || item.status === 'cached') return item;
        const cached = tempTm[item.source.trim()];
        if (cached) { completedInFile++; return { ...item, target: cached, status: 'cached' as const, confidence: 100 }; }
        return item;
      });
      setCurrentItems(updatedWithCache);
      const pending = updatedWithCache.filter(i => i.status === 'pending' || i.status === 'failed');
      
      for (let i = 0; i < pending.length; i += batchSize) {
        if (shouldStopRef.current) break;
        const batch = pending.slice(i, i + batchSize);
        const batchIds = batch.map(b => b.id);
        setCurrentItems(prev => prev.map(item => batchIds.includes(item.id) ? { ...item, status: 'processing' } : item));
        try {
          let results = [];
          if (serviceType === 'gemini') {
             const key = geminiKeys.length > 0 ? geminiKeys[activeKeyIndexRef.current % geminiKeys.length] : undefined;
             results = await geminiTranslatorRef.current!.translateBatch(batch, JSON.stringify(glossary), geminiModel, key);
          } else {
             results = await deepLTranslatorRef.current!.translateBatch(batch, deepLKeyInput, JSON.stringify(glossary));
          }
          const newEntries: Record<string, string> = {};
          setCurrentItems(prev => {
            const next = [...prev];
            results.forEach((res: any) => {
              const idx = next.findIndex(item => item.id === res.id);
              if (idx !== -1) {
                next[idx].target = res.translation;
                next[idx].status = 'done';
                next[idx].confidence = res.confidence;
                next[idx].validationNote = res.critique;
                newEntries[next[idx].source.trim()] = res.translation;
              }
            });
            fileResultsRef.current[fileQueue[fIdx].name] = next;
            return next;
          });
          tempTm = { ...tempTm, ...newEntries };
          completedInFile += results.length;
          setEventStats(prev => ({ ...prev, apiCalls: prev.apiCalls + 1 }));
          setFileQueue(prev => prev.map((f, idx) => idx === fIdx ? { ...f, progress: Math.round((completedInFile / items.length) * 100), completedItems: completedInFile } : f));
          await new Promise(r => setTimeout(r, serviceType === 'gemini' ? WAIT_TIME_MS : 1000));
        } catch (err: any) {
          if (err.message === 'RATE_LIMIT' && serviceType === 'gemini') {
             if (geminiKeys.length > 1) {
                 activeKeyIndexRef.current = (activeKeyIndexRef.current + 1) % geminiKeys.length;
                 const nextKeyIdx = activeKeyIndexRef.current + 1;
                 addToast(`Ліміт! Зміна ключа на #${nextKeyIdx}`, "info");
                 i -= batchSize; 
                 continue;
             }
             setCooldown(65);
             await new Promise(r => setTimeout(r, 65000));
             i -= batchSize; continue;
          }
          setCurrentItems(prev => prev.map(item => batchIds.includes(item.id) ? { ...item, status: 'failed' } : item));
          setEventStats(prev => ({ ...prev, errors: prev.errors + 1 }));
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      const final = fileResultsRef.current[fileQueue[fIdx].name] || [];
      const isComplete = final.every(it => it.status === 'done' || it.status === 'cached');
      setFileQueue(prev => prev.map((f, idx) => idx === fIdx ? { ...f, status: isComplete ? 'done' : 'error' } : f));
      setTm(tempTm);
      localStorage.setItem(STORAGE_KEY_TM, JSON.stringify(tempTm));
      saveProjectState();
    }
    setIsProcessing(false);
  };

  const downloadFile = async (fileEntry: FileEntry) => {
    const results = fileResultsRef.current[fileEntry.name];
    if (!results) return;
    const header = "key,source,target\n";
    const rows = results.map(item => `"${item.key}","${item.source.replace(/"/g, '""')}","${(item.target || '').replace(/"/g, '""')}"`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8-sig;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = fileEntry.name; link.click(); URL.revokeObjectURL(url);
  };

  const downloadAll = async () => {
    const processedFiles = fileQueue.filter(f => f.status === 'done' || (fileResultsRef.current[f.name] && fileResultsRef.current[f.name].length > 0));
    if (processedFiles.length === 0) {
      addToast("Немає файлів для завантаження", "error");
      return;
    }
    for (const file of processedFiles) {
      await downloadFile(file);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    addToast(`Розпочато завантаження ${processedFiles.length} файлів`);
  };

  return (
    <div className="flex h-screen w-full text-slate-400 p-4 md:p-6 gap-6 overflow-hidden relative">
      <div className="fixed top-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <div key={toast.id} className={`animate-pop pointer-events-auto px-4 py-3 rounded-xl border shadow-2xl flex items-center gap-3 backdrop-blur-xl ${toast.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : toast.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${toast.type === 'success' ? 'bg-emerald-500' : toast.type === 'error' ? 'bg-red-500' : 'bg-blue-500'}`}></div>
            <p className="text-[10px] font-black uppercase tracking-widest">{toast.message}</p>
          </div>
        ))}
      </div>

      <aside className="w-[340px] flex flex-col gap-5 shrink-0 h-full overflow-hidden">
        <section className="glass rounded-2xl p-6 flex flex-col gap-5 shrink-0 relative overflow-hidden group">
          <header className="flex items-center justify-between relative z-10">
             <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(59,130,246,0.3)]">
                   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>
                </div>
                <div>
                   <h1 className="text-xl font-black text-white uppercase">Linguist</h1>
                   <div className="flex items-center gap-1.5 mt-0.5"><span className="text-[9px] font-bold bg-blue-500/20 text-blue-400 px-1.5 rounded uppercase">Pro</span></div>
                </div>
             </div>
             <button onClick={resetProject} className="text-slate-600 hover:text-red-400 p-2"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
          </header>

          <div onDragOver={e => {e.preventDefault(); setIsDragging(true)}} onDragLeave={() => setIsDragging(false)} onDrop={e => {e.preventDefault(); setIsDragging(false); addFilesToQueue(Array.from(e.dataTransfer.files))}} className={`relative border border-dashed rounded-xl py-8 px-4 flex flex-col items-center transition-all ${isDragging ? 'bg-blue-500/10 border-blue-500/50' : 'bg-white/[0.02] border-white/10 hover:border-white/20'}`}>
            <input type="file" multiple accept=".csv" onChange={e => addFilesToQueue(Array.from(e.target.files || []))} className="absolute inset-0 opacity-0 cursor-pointer" />
            <div className="w-12 h-12 mb-3 bg-white/5 rounded-2xl flex items-center justify-center border border-white/5"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
            <p className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Завантажте CSV</p>
          </div>

          {!isProcessing ? (
             <button onClick={startBatchProcess} disabled={fileQueue.length === 0} className="w-full py-4 rounded-xl font-black uppercase tracking-widest text-[10px] bg-white text-slate-950 hover:bg-blue-400 hover:text-white transition-all">Розпочати Локалізацію</button>
          ) : (
             <button onClick={() => {shouldStopRef.current=true; setIsProcessing(false)}} className="w-full py-4 rounded-xl font-black uppercase tracking-widest text-[10px] bg-red-500/10 border border-red-500/50 text-red-400 flex items-center justify-center gap-2"><div className="w-2 h-2 bg-current rounded-sm"></div> Зупинити</button>
          )}

          <div className="pt-5 border-t border-white/5 space-y-4">
             <div className="flex bg-slate-950/50 p-1 rounded-xl border border-white/5">
                <button onClick={() => setServiceType('gemini')} className={`flex-1 py-2 text-[9px] font-black uppercase rounded-lg transition-all ${serviceType === 'gemini' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-500'}`}>Gemini</button>
                <button onClick={() => setServiceType('deepl')} className={`flex-1 py-2 text-[9px] font-black uppercase rounded-lg transition-all ${serviceType === 'deepl' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500'}`}>DeepL</button>
             </div>

             {serviceType === 'gemini' && (
               <div className="space-y-4">
                  <div>
                    <label className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2 block pl-1">Модель Gemini</label>
                    <select value={geminiModel} onChange={e => setGeminiModel(e.target.value)} className="w-full bg-slate-950/50 border border-white/5 rounded-xl px-3 py-2 text-[10px] font-mono text-slate-300 outline-none focus:border-blue-500/50">
                      <option value="gemini-3-pro-preview">Gemini 3 Pro (Якісно)</option>
                      <option value="gemini-3-flash-preview">Gemini 3 Flash (Швидко)</option>
                      <option value="gemini-flash-latest">Gemini Flash Latest</option>
                      <option value="gemini-flash-lite-latest">Gemini Flash Lite Latest</option>
                    </select>
                  </div>
                  
                  <div className="group relative">
                      <label className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2 block pl-1">API Keys (Comma Separated)</label>
                      <textarea value={geminiKeysInput} onChange={e => setGeminiKeysInput(e.target.value)} placeholder="Key1, Key2..." className="w-full bg-slate-950/50 border border-white/5 rounded-xl px-3 py-2 text-[10px] font-mono text-slate-300 outline-none h-[60px] resize-none focus:border-blue-500/50" />
                  </div>
               </div>
             )}

             {serviceType === 'deepl' && (
               <div className="group relative">
                  <label className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2 block pl-1">DeepL Auth Key</label>
                  <input type="password" value={deepLKeyInput} onChange={e => setDeepLKeyInput(e.target.value)} placeholder="Enter DeepL Auth Key..." className="w-full bg-slate-950/50 border border-white/5 rounded-xl px-3 py-3 text-[10px] font-mono text-slate-300 outline-none focus:border-indigo-500/50" />
               </div>
             )}

             <button onClick={handleSaveConfig} className="w-full mt-2 bg-white/5 hover:bg-white/10 text-slate-400 py-2 rounded-lg text-[9px] font-black uppercase border border-white/5 flex items-center justify-center gap-1.5 transition-all">ЗБЕРЕГТИ НАЛАШТУВАННЯ</button>
             
             <div>
                <div className="flex justify-between mb-2 px-1">
                    <label className="text-[9px] font-black uppercase tracking-widest text-slate-500">Батч (1-1000)</label>
                    <span className="text-[9px] font-mono text-blue-400">{batchSize}</span>
                </div>
                <input type="range" min="1" max="1000" step="1" value={batchSize} onChange={e => setBatchSize(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer" />
             </div>
          </div>
        </section>
        <section className="flex-1 min-h-0 overflow-hidden"><GlossaryManager glossary={glossary} onUpdate={setGlossary} /></section>
      </aside>

      <main className="flex-1 flex flex-col gap-5 h-full overflow-hidden">
        <div className="grid grid-cols-4 gap-4 shrink-0">
           <div className="glass p-4 rounded-xl relative overflow-hidden">
               <p className="text-[9px] font-black uppercase text-slate-500 mb-1">Файли</p>
               <p className="text-2xl font-bold text-white font-mono">{stats.completedFiles}<span className="text-slate-600 text-lg">/{stats.totalFiles}</span></p>
           </div>
           <div className="glass p-4 rounded-xl relative overflow-hidden">
               <p className="text-[9px] font-black uppercase text-slate-500 mb-1">Рядки</p>
               <p className="text-2xl font-bold text-emerald-400 font-mono">{stats.completedStrings.toLocaleString()}</p>
               <div className="w-full bg-white/5 h-1 mt-2 rounded-full overflow-hidden"><div className="h-full bg-emerald-500" style={{width: `${sessionPercentage}%`}}></div></div>
           </div>
           <div className="glass p-4 rounded-xl relative overflow-hidden">
               <p className="text-[9px] font-black uppercase text-slate-500 mb-1">Cache</p>
               <p className="text-2xl font-bold text-blue-400 font-mono">{stats.cachedStrings.toLocaleString()}</p>
           </div>
           <div className="glass p-4 rounded-xl relative overflow-hidden">
               <p className="text-[9px] font-black uppercase text-slate-500 mb-1">API</p>
               <p className="text-2xl font-bold text-amber-400 font-mono">{stats.apiCalls}</p>
           </div>
        </div>

        <div className="glass rounded-2xl flex flex-col flex-1 relative border border-white/5 min-h-0 overflow-hidden">
          {isProcessing && <div className="absolute top-0 left-0 right-0 h-[3px] bg-slate-900 z-50"><div className="h-full bg-blue-500 progress-striped" style={{ width: `${sessionPercentage}%`, transition: 'width 0.5s ease' }}></div></div>}
          <header className="p-4 bg-slate-900/40 border-b border-white/5 flex justify-between items-center backdrop-blur-md">
             <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isProcessing ? 'text-blue-500 animate-pulse' : 'text-slate-600'}`} style={{boxShadow: '0 0 8px currentColor'}}></div>
                <h3 className="font-bold text-[11px] uppercase tracking-widest text-slate-300 truncate max-w-[400px]">
                  {currentFileIndex >= 0 ? (fileQueue[currentFileIndex]?.name || 'Файл не вибрано') : 'Очікування'}
                </h3>
             </div>
             <button onClick={() => downloadFile(fileQueue[currentFileIndex])} disabled={currentFileIndex < 0} className="hover:text-emerald-400 text-slate-500 disabled:opacity-30"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
          </header>
          
          <div className="overflow-y-auto custom-scrollbar flex-1 bg-slate-900/20">
            <table className="w-full text-left text-[11px] border-collapse table-fixed">
              <thead className="sticky top-0 bg-[#0b1121] shadow-lg z-10 border-b border-white/5">
                <tr>
                  <th className="p-4 w-[12%] font-black text-slate-500 uppercase text-[9px]">Key</th>
                  <th className="p-4 w-[36%] font-black text-slate-500 uppercase text-[9px]">English</th>
                  <th className="p-4 w-[36%] font-black text-slate-500 uppercase text-[9px]">Ukrainian</th>
                  <th className="p-4 w-[16%] font-black text-slate-500 uppercase text-[9px] text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.02]">
                {currentItems.length === 0 ? (
                  <tr><td colSpan={4} className="p-32 text-center opacity-20 text-xs font-black uppercase tracking-[0.4em]">Виберіть файл зі списку</td></tr>
                ) : currentItems.map((item) => (
                  <tr key={`${item.fileName}-${item.id}`} className={`hover:bg-white/[0.02] transition-colors group/row ${item.status === 'done' ? 'bg-emerald-500/[0.01]' : ''}`}>
                    <td className="p-4 align-top border-r border-white/[0.02]"><code className="text-[10px] text-blue-400/80 font-mono block truncate">{item.key}</code></td>
                    <td className="p-4 align-top border-r border-white/[0.02]"><p className="text-slate-400 leading-relaxed font-mono whitespace-pre-wrap">{item.source}</p></td>
                    <td className="p-4 align-top border-r border-white/[0.02] relative">
                       {item.target !== undefined ? (
                         <div className="relative group/edit h-full">
                           <textarea className={`w-full bg-transparent border-0 p-0 text-slate-200 text-[11px] font-mono outline-none focus:bg-slate-800/50 rounded pr-14 min-h-[80px] resize-y overflow-y-auto ${item.isEdited ? 'text-amber-200' : ''}`} value={item.target} onChange={e => handleManualEdit(item.id, e.target.value)} spellCheck={false} />
                           {/* Hover Buttons fixed to row hover and inside the cell */}
                           <div className="absolute right-2 top-2 opacity-0 group-hover/row:opacity-100 flex flex-col gap-1 z-20 transition-all pointer-events-auto">
                              <button onClick={() => reValidateItem(item.id)} className="text-[8px] uppercase font-bold text-slate-300 hover:text-white px-2 py-1 bg-slate-800/80 hover:bg-blue-600 rounded border border-white/10 shadow-lg backdrop-blur">Fix</button>
                              <button onClick={() => setGlossary(prev => ({...prev, [item.source.trim()]: item.target!}))} className="text-[8px] uppercase font-bold text-slate-300 hover:text-white px-2 py-1 bg-slate-800/80 hover:bg-emerald-600 rounded border border-white/10 shadow-lg backdrop-blur">+Gloss</button>
                           </div>
                         </div>
                       ) : <div className="flex gap-1 py-1 opacity-30"><div className="w-1 h-1 bg-white rounded-full animate-bounce"></div><div className="w-1 h-1 bg-white rounded-full animate-bounce delay-100"></div><div className="w-1 h-1 bg-white rounded-full animate-bounce delay-200"></div></div>}
                    </td>
                    <td className="p-4 align-top text-right">
                       <div className="flex flex-col items-end gap-1">
                          <span className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${item.status === 'done' ? 'text-emerald-500 bg-emerald-500/10' : item.status === 'cached' ? 'text-blue-400 bg-blue-500/10' : item.status === 'failed' ? 'text-red-500 bg-red-500/10' : 'text-slate-600 bg-white/5'}`}>{item.status}</span>
                          {item.confidence !== undefined && <div className="w-16 h-1 bg-slate-800 rounded-full mt-1 overflow-hidden"><div className={`h-full ${item.confidence > 90 ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{width: `${item.confidence}%`}}></div></div>}
                       </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <aside className="w-[340px] flex flex-col h-full overflow-hidden shrink-0">
        <div className="glass rounded-3xl p-5 h-full flex flex-col border border-white/5 relative overflow-hidden">
           <header className="flex justify-between items-center mb-5 shrink-0">
              <div className="flex items-center gap-2"><div className="w-1.5 h-4 bg-gradient-to-b from-blue-500 to-indigo-500 rounded-sm"></div><h2 className="text-[10px] font-black uppercase text-slate-400">Черга Файлів</h2></div>
              <button onClick={downloadAll} className="text-[9px] font-bold text-white bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg transition-all uppercase">Скачати Все</button>
           </header>
           <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar min-h-0">
              {fileQueue.length === 0 && <div className="flex flex-col items-center justify-center py-20 opacity-20 border-2 border-dashed border-white/5 rounded-2xl"><p className="text-[9px] font-black uppercase text-center px-4">Список порожній</p></div>}
              {fileQueue.map((file, idx) => (
                <div key={`${file.name}-${idx}`} onClick={() => { if(!isProcessing){ setCurrentFileIndex(idx); processFileMetadata(file).then(setCurrentItems); } }} className={`relative group p-4 rounded-xl border transition-all cursor-pointer overflow-hidden ${idx === currentFileIndex ? 'bg-blue-500/10 border-blue-500/40 active-file-glow' : 'bg-white/[0.01] border-white/5 hover:border-white/20'}`}>
                  <div className="flex justify-between items-start mb-3 relative z-10">
                    <div className="min-w-0 pr-2">
                      <p className={`text-[11px] font-bold truncate transition-colors ${idx === currentFileIndex ? 'text-blue-200' : 'text-slate-300'}`}>{file.name}</p>
                      <div className="flex items-center gap-2 mt-1"><span className={`text-[9px] font-black px-1.5 rounded-sm ${file.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' : file.status === 'processing' ? 'bg-blue-500/20 text-blue-400' : file.status === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-slate-700/30 text-slate-500'}`}>{file.status.toUpperCase()}</span></div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                         <button onClick={e => {e.stopPropagation(); downloadFile(file)}} className="p-1.5 hover:bg-emerald-500/20 text-slate-400 hover:text-emerald-400"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
                         <button onClick={e => {e.stopPropagation(); handleRetryFile(idx)}} className="p-1.5 hover:bg-white/10 text-slate-400 hover:text-white"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
                         <button onClick={e => {e.stopPropagation(); deleteFile(idx)}} className="p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-400"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    </div>
                  </div>
                  <div className="relative z-10">
                      <div className="flex justify-between text-[9px] font-mono text-slate-500 mb-1"><span>{file.completedItems} / {file.totalItems || '?'}</span><span>{file.progress}%</span></div>
                      <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-white/5"><div className={`h-full transition-all duration-500 ${file.status === 'done' ? 'bg-emerald-500' : file.status === 'error' ? 'bg-red-500' : 'bg-gradient-to-r from-blue-600 to-blue-400'}`} style={{ width: `${file.progress}%` }}></div></div>
                  </div>
                </div>
              ))}
           </div>
        </div>
      </aside>
    </div>
  );
};

export default App;

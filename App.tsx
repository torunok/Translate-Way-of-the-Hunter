import React, { useState, useEffect, useRef, useMemo } from 'react';
import { INITIAL_GLOSSARY } from './constants';
import { TranslationItem, LocalizationStats, TranslationMemory, FileEntry, ToastMessage } from './types';
import { GeminiTranslator } from './services/geminiService';
import GlossaryManager from './components/GlossaryManager';

const BATCH_SIZE = 5; 
const WAIT_TIME_MS = 4000; 
const RATE_LIMIT_WAIT_MS = 65000;
const MAX_FILES = 50;

const App: React.FC = () => {
  const [glossary, setGlossary] = useState<Record<string, string>>(INITIAL_GLOSSARY);
  const [fileQueue, setFileQueue] = useState<FileEntry[]>([]);
  const [currentItems, setCurrentItems] = useState<TranslationItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentFileIndex, setCurrentFileIndex] = useState(-1);
  const [isDragging, setIsDragging] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [tm, setTm] = useState<TranslationMemory>(() => {
    const saved = localStorage.getItem('linguist_tm');
    return saved ? JSON.parse(saved) : {};
  });
  const [stats, setStats] = useState<LocalizationStats>({
    totalFiles: 0,
    completedFiles: 0,
    totalStrings: 0,
    completedStrings: 0,
    cachedStrings: 0,
    apiCalls: 0,
    errors: 0
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('gemini_api_key') || '');

  const fileResultsRef = useRef<Record<string, TranslationItem[]>>({});
  const translatorRef = useRef<GeminiTranslator | null>(null);

  useEffect(() => {
    translatorRef.current = new GeminiTranslator();
  }, []);

  useEffect(() => {
    if (cooldown > 0) {
      const timer = setInterval(() => {
        setCooldown(prev => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [cooldown]);

  const addToast = (message: string, type: ToastMessage['type'] = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  };

  const addFilesToQueue = (files: File[]) => {
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
    if (csvFiles.length === 0) {
      setErrorMsg("Будь ласка, завантажуйте лише CSV файли.");
      return;
    }
    if (fileQueue.length + csvFiles.length > MAX_FILES) {
      setErrorMsg(`Максимальний ліміт ${MAX_FILES} файлів вичерпано.`);
      return;
    }

    setErrorMsg(null);
    const newFiles: FileEntry[] = csvFiles.map(f => ({
      name: f.name,
      status: 'pending',
      progress: 0,
      totalItems: 0,
      completedItems: 0,
      rawFile: f
    } as any));

    setFileQueue(prev => [...prev, ...newFiles]);
    setStats(prev => ({ ...prev, totalFiles: prev.totalFiles + csvFiles.length }));
    addToast(`Додано ${csvFiles.length} файл(ів)`);
  };

  const moveFile = (index: number, direction: -1 | 1) => {
    const newQueue = [...fileQueue];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newQueue.length) return;
    
    // Don't allow moving a file that is currently processing or already done past pending files if it breaks logical flow, 
    // but usually user just wants to reorder pending tasks.
    [newQueue[index], newQueue[targetIndex]] = [newQueue[targetIndex], newQueue[index]];
    setFileQueue(newQueue);
  };

  const handleFilesUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    addFilesToQueue(files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    addFilesToQueue(files);
  };

  const processFileMetadata = async (fileEntry: any) => {
    return new Promise<TranslationItem[]>((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        const lines = text.split('\n');
        const header = lines[0].split(',');
        const keyIdx = header.findIndex(h => h.trim().toLowerCase() === 'key');
        const sourceIdx = header.findIndex(h => h.trim().toLowerCase() === 'source');

        const items: TranslationItem[] = [];
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const cols = lines[i].split(',');
          const source = cols[sourceIdx]?.replace(/^"|"$/g, '').trim() || '';
          const key = keyIdx !== -1 ? cols[keyIdx]?.replace(/^"|"$/g, '').trim() : `ряд_${i}`;
          if (source) items.push({ id: i, key, source, status: 'pending', fileName: fileEntry.name });
        }
        resolve(items);
      };
      reader.readAsText(fileEntry.rawFile);
    });
  };

  const addToGlossary = (source: string, target: string) => {
    setGlossary(prev => ({ ...prev, [source]: target }));
    addToast("Глосарій оновлено");
  };

  const handleManualEdit = (id: string | number, newTarget: string) => {
    setCurrentItems(prev => prev.map(item => 
      item.id === id ? { ...item, target: newTarget, isEdited: true } : item
    ));
  };

  const reValidateItem = async (id: string | number) => {
    const item = currentItems.find(i => i.id === id);
    if (!item || !translatorRef.current) return;

    setCurrentItems(prev => prev.map(i => i.id === id ? { ...i, status: 'processing' } : i));
    
    try {
      const glossaryJson = JSON.stringify(glossary);
      const results = await translatorRef.current.translateBatch([item], glossaryJson, apiKey);
      
      if (results && results[0]) {
        const result = results[0];
        setCurrentItems(prev => prev.map(i => 
          i.id === id ? { 
            ...i, 
            target: result.translation, 
            status: 'done', 
            confidence: result.confidence, 
            validationNote: result.critique,
            isEdited: false 
          } : i
        ));

        if (result.confidence > 80) {
          const newTm = { ...tm, [item.source.trim()]: result.translation };
          setTm(newTm);
          localStorage.setItem('linguist_tm', JSON.stringify(newTm));
          addToast("Запис перевалідовано та збережено в кеш");
        } else {
          addToast("Запис перевалідовано", "info");
        }
      }
    } catch (err: any) {
      if (err.message === 'RATE_LIMIT') {
        setErrorMsg("Квота API вичерпана. Спробуйте пізніше.");
        setCooldown(65);
      } else {
        setErrorMsg(`Помилка: ${err.message}`);
      }
      setCurrentItems(prev => prev.map(i => i.id === id ? { ...i, status: 'failed' } : i));
    }
  };

  const startBatchProcess = async () => {
    if (!translatorRef.current || fileQueue.length === 0 || isProcessing) return;
    setIsProcessing(true);
    setErrorMsg(null);

    let tempTm = { ...tm };
    // Always iterate through queue. Reordering will change the order of iteration if index is used.
    for (let fIdx = 0; fIdx < fileQueue.length; fIdx++) {
      if (fileQueue[fIdx].status === 'done') continue;
      const items = await processFileMetadata(fileQueue[fIdx]);
      setCurrentFileIndex(fIdx);
      setFileQueue(prev => prev.map((f, i) => i === fIdx ? { ...f, status: 'processing', totalItems: items.length } : f));
      setStats(prev => ({ ...prev, totalStrings: prev.totalStrings + items.length }));
      setCurrentItems(items);
      
      let completedInFile = 0;
      const glossaryJson = JSON.stringify(glossary);
      const updatedWithCache = items.map(item => {
        const cached = tempTm[item.source.trim()];
        if (cached) {
          completedInFile++;
          return { ...item, target: cached, status: 'cached' as const, confidence: 100 };
        }
        return item;
      });

      setCurrentItems(updatedWithCache);
      setStats(prev => ({ ...prev, cachedStrings: prev.cachedStrings + completedInFile, completedStrings: prev.completedStrings + completedInFile }));

      const initialFileProg = Math.round((completedInFile / items.length) * 100);
      setFileQueue(prev => prev.map((f, idx) => idx === fIdx ? { ...f, progress: initialFileProg, completedItems: completedInFile } : f));

      const pending = updatedWithCache.filter(i => i.status === 'pending');
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const batch = pending.slice(i, i + BATCH_SIZE);
        const batchIds = batch.map(b => b.id);
        setCurrentItems(prev => prev.map(item => batchIds.includes(item.id) ? { ...item, status: 'processing' } : item));

        try {
          const results = await translatorRef.current.translateBatch(batch, glossaryJson, apiKey);
          const newEntries: Record<string, string> = {};
          setCurrentItems(prev => {
            const next = [...prev];
            results.forEach(res => {
              const idx = next.findIndex(item => item.id === res.id);
              if (idx !== -1) {
                next[idx].target = res.translation;
                next[idx].status = 'done';
                next[idx].confidence = res.confidence;
                next[idx].validationNote = res.critique;
                newEntries[next[idx].source.trim()] = res.translation;
              }
            });
            return next;
          });
          tempTm = { ...tempTm, ...newEntries };
          completedInFile += results.length;
          setStats(prev => ({ ...prev, apiCalls: prev.apiCalls + 1, completedStrings: prev.completedStrings + results.length }));
          const fileProg = Math.round((completedInFile / items.length) * 100);
          setFileQueue(prev => prev.map((f, idx) => idx === fIdx ? { ...f, progress: fileProg, completedItems: completedInFile } : f));
          
          await new Promise(r => setTimeout(r, WAIT_TIME_MS));
        } catch (err: any) {
          if (err.message === 'RATE_LIMIT') {
            setErrorMsg("ПЕРЕВИЩЕНО КВОТУ API. ОЧІКУВАННЯ 60с...");
            setCooldown(65);
            await new Promise(r => setTimeout(r, RATE_LIMIT_WAIT_MS));
            setErrorMsg(null);
            i -= BATCH_SIZE; 
            continue;
          } else {
            setCurrentItems(prev => prev.map(item => batchIds.includes(item.id) ? { ...item, status: 'failed' } : item));
            setStats(prev => ({ ...prev, errors: prev.errors + 1 }));
            setErrorMsg(`Помилка: ${err.message}`);
          }
        }
      }

      setCurrentItems(prev => {
        fileResultsRef.current[fileQueue[fIdx].name] = prev;
        return prev;
      });
      setFileQueue(prev => prev.map((f, idx) => idx === fIdx ? { ...f, status: 'done', progress: 100 } : f));
      setStats(prev => ({ ...prev, completedFiles: prev.completedFiles + 1 }));
      setTm(tempTm);
      localStorage.setItem('linguist_tm', JSON.stringify(tempTm));
      addToast(`Файл "${fileQueue[fIdx].name}" завершено`);
    }
    setIsProcessing(false);
    addToast("Всі файли оброблено");
  };

  const downloadFile = (fileName: string) => {
    const results = fileResultsRef.current[fileName];
    if (!results) return;
    const header = "key,source,target,confidence,note\n";
    const rows = results.map(item => `"${item.key}","${item.source.replace(/"/g, '""')}","${(item.target || '').replace(/"/g, '""')}","${item.confidence || ''}","${(item.validationNote || '').replace(/"/g, '""')}"`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8-sig;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `localized_${fileName}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadAll = () => {
    const completedFiles = fileQueue.filter(f => f.status === 'done');
    if (completedFiles.length === 0) {
      addToast("Немає завершених файлів для завантаження", "info");
      return;
    }
    
    completedFiles.forEach((file, index) => {
      // Small delay to prevent browser download interruption
      setTimeout(() => {
        downloadFile(file.name);
      }, index * 200);
    });
    addToast(`Почато завантаження ${completedFiles.length} файлів`);
  };

  const sessionPercentage = useMemo(() => {
    if (stats.totalStrings === 0) return 0;
    return Math.round((stats.completedStrings / stats.totalStrings) * 100);
  }, [stats.completedStrings, stats.totalStrings]);

  return (
    <div className="flex h-screen w-full bg-[#020617] text-slate-400 p-4 md:p-6 lg:p-8 gap-6 overflow-hidden relative">
      {/* Notifications */}
      <div className="fixed top-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <div 
            key={toast.id} 
            className={`animate-pop pointer-events-auto px-4 py-3 rounded-xl border shadow-2xl flex items-center gap-3 backdrop-blur-xl ${
              toast.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
              toast.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
              'bg-blue-500/10 border-blue-500/20 text-blue-400'
            }`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${toast.type === 'success' ? 'bg-emerald-500' : toast.type === 'error' ? 'bg-red-500' : 'bg-blue-500'}`}></div>
            <p className="text-[10px] font-black uppercase tracking-widest">{toast.message}</p>
          </div>
        ))}
      </div>

      {/* ЛІВА ПАНЕЛЬ */}
      <aside className="w-[320px] flex flex-col gap-6 shrink-0 h-full overflow-hidden">
        <section className="glass rounded-2xl p-6 flex flex-col gap-6 shrink-0 overflow-hidden relative group">
          <div className="scanning absolute inset-0 opacity-10 pointer-events-none"></div>
          <header className="flex items-center gap-3 relative">
            <div className="w-10 h-10 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>
            </div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none uppercase">Linguist <span className="text-blue-500">Pro</span></h1>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-0.5">Двигун v3.0</p>
            </div>
          </header>

          <div 
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative w-full border border-dashed rounded-xl py-8 px-4 flex flex-col items-center justify-center transition-all duration-300 ${
              isDragging ? 'bg-blue-500/10 border-blue-500/50 scale-[1.02]' : 'bg-white/[0.02] border-white/10 hover:border-white/20'
            }`}
          >
            <input type="file" multiple accept=".csv" onChange={handleFilesUpload} className="absolute inset-0 opacity-0 cursor-pointer" id="multi-csv" />
            <div className="w-12 h-12 mb-3 bg-white/5 rounded-full flex items-center justify-center border border-white/5">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`${isDragging ? 'text-blue-400 animate-bounce' : 'text-slate-500'}`}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </div>
            <p className="text-[10px] font-bold text-slate-300 uppercase tracking-widest text-center">Завантажте CSV</p>
            <p className="text-[9px] text-slate-600 font-medium uppercase mt-1">Максимум 50 файлів</p>
          </div>

          <button 
            onClick={startBatchProcess} 
            disabled={isProcessing || fileQueue.length === 0} 
            className={`w-full py-3.5 rounded-xl font-black uppercase tracking-widest text-[10px] shadow-lg transition-all ${
              isProcessing 
              ? 'bg-slate-800 text-slate-600 cursor-not-allowed' 
              : 'bg-white text-slate-950 hover:bg-blue-50 active:scale-[0.98]'
            }`}
          >
            {isProcessing ? 'Процес іде...' : 'Розпочати'}
          </button>

          {errorMsg && <p className="text-[9px] font-bold text-red-400 text-center animate-pop">{errorMsg}</p>}
          {cooldown > 0 && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-center animate-pop shadow-[0_0_15px_rgba(245,158,11,0.1)]">
              <p className="text-amber-500 text-[9px] font-black uppercase tracking-widest mb-1">Охолодження API</p>
              <p className="text-xl font-mono text-amber-500 font-bold">{cooldown}с</p>
            </div>
          )}

          <div className="pt-4 border-t border-white/5">
             <div className="flex items-center justify-between mb-2">
                <label className="text-[9px] font-black uppercase tracking-widest text-slate-500">Налаштування API Key</label>
             </div>
             <div className="flex gap-2">
                <input 
                    type="password" 
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Вставте ключ Gemini..."
                    className="flex-1 bg-white/[0.03] border border-white/5 hover:border-white/10 focus:border-blue-500/30 rounded-lg px-3 py-2 text-[10px] text-slate-300 outline-none transition-all placeholder:text-slate-700"
                />
                <button 
                    onClick={() => {
                        localStorage.setItem('gemini_api_key', apiKey);
                        addToast("Ключ збережено", "success");
                    }}
                    className="bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white px-3 rounded-lg text-[10px] font-bold transition-all border border-white/5"
                    title="Зберегти ключ"
                >
                    💾
                </button>
             </div>
          </div>
        </section>

        <section className="flex-1 min-h-0 overflow-hidden">
          <GlossaryManager glossary={glossary} onUpdate={setGlossary} />
        </section>
      </aside>

      {/* ГОЛОВНА ПАНЕЛЬ */}
      <main className="flex-1 flex flex-col gap-6 h-full overflow-hidden">
        <div className="grid grid-cols-4 gap-4 shrink-0">
           {[
             { label: 'Файли', val: `${stats.completedFiles}/${stats.totalFiles}`, icon: '📂' },
             { label: 'Рядки', val: `${stats.completedStrings}/${stats.totalStrings || '?'}`, icon: '📄' },
             { label: 'Кеш', val: stats.cachedStrings.toLocaleString(), icon: '🧠' },
             { label: 'Помилки', val: stats.errors, icon: '⚠️' }
           ].map((s, i) => (
             <div key={i} className="glass p-5 rounded-2xl border border-white/5 transition-all hover:border-white/10 group">
               <div className="flex justify-between items-start mb-2">
                 <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">{s.label}</p>
                 <span className="text-xs grayscale group-hover:grayscale-0 transition-all">{s.icon}</span>
               </div>
               <p className="text-lg font-bold text-white tracking-tight font-mono truncate">{s.val}</p>
             </div>
           ))}
        </div>

        <div className="glass rounded-2xl flex flex-col flex-1 shadow-2xl relative border border-white/5 min-h-0 overflow-hidden">
          {isProcessing && (
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-slate-900 z-50 overflow-hidden">
              <div className="h-full bg-blue-500 shadow-[0_0_15px_#3b82f6] progress-bar-transition" style={{ width: `${sessionPercentage}%` }}></div>
            </div>
          )}
          
          <header className="p-5 bg-white/[0.01] border-b border-white/5 flex justify-between items-center backdrop-blur-xl shrink-0">
             <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-blue-500 animate-pulse' : 'bg-slate-700'}`}></div>
                <h3 className="font-bold text-[10px] uppercase tracking-widest text-slate-400 truncate max-w-[400px]">
                  {currentFileIndex >= 0 ? `Процес: ${fileQueue[currentFileIndex].name}` : 'Двигун в режимі очікування'}
                </h3>
             </div>
             <div className="flex items-center gap-4">
                {isProcessing && (
                   <span className="text-[9px] font-bold font-mono text-blue-400 bg-blue-500/10 px-2.5 py-1 rounded-full animate-pop border border-blue-500/20">
                      Sync: {sessionPercentage}%
                   </span>
                )}
                <div className="flex bg-slate-950/50 rounded-lg p-1 border border-white/5">
                   <button className="px-3 py-1 bg-white/5 text-white rounded text-[9px] font-bold uppercase tracking-widest">Всі</button>
                   <button className="px-3 py-1 text-slate-600 hover:text-slate-400 rounded text-[9px] font-bold uppercase tracking-widest transition-colors">Огляд</button>
                </div>
             </div>
          </header>
          
          <div className="overflow-y-auto custom-scrollbar flex-1 bg-white/[0.005]">
            <table className="w-full text-left text-[11px] border-collapse table-fixed">
              <thead className="sticky top-0 bg-[#0f172a] shadow-md z-10 border-b border-white/5">
                <tr>
                  <th className="p-4 w-[15%] font-black text-slate-500 uppercase tracking-widest text-[9px]">ID / Ключ</th>
                  <th className="p-4 w-[35%] font-black text-slate-500 uppercase tracking-widest text-[9px]">Оригінал (EN)</th>
                  <th className="p-4 w-[35%] font-black text-slate-500 uppercase tracking-widest text-[9px]">Локалізація (UA)</th>
                  <th className="p-4 w-[15%] font-black text-slate-500 uppercase tracking-widest text-[9px] text-right">Якість</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.02]">
                {currentItems.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-24 text-center">
                      <div className="flex flex-col items-center opacity-10">
                         <div className="text-4xl mb-4">🌀</div>
                         <p className="font-black uppercase tracking-[0.4em] text-xs">Немає активних даних</p>
                      </div>
                    </td>
                  </tr>
                ) : currentItems.map((item) => (
                  <tr key={`${item.fileName}-${item.id}`} className={`hover:bg-white/[0.02] transition-all duration-300 table-row-transition ${item.status === 'done' || item.status === 'cached' ? 'status-flash-success' : ''}`}>
                    <td className="p-4 align-top">
                      <code className="text-[10px] text-blue-400/80 font-mono bg-blue-500/5 px-1.5 py-0.5 rounded border border-blue-500/10 block truncate">{item.key}</code>
                    </td>
                    <td className="p-4 align-top">
                      <p className="text-slate-400 leading-relaxed break-words">{item.source}</p>
                    </td>
                    <td className="p-4 align-top">
                      <div className="flex flex-col gap-2 min-h-[32px]">
                        {item.target !== undefined ? (
                          <div className="animate-pop relative group/edit">
                            <textarea 
                              className={`w-full bg-slate-950/30 border rounded-lg p-2.5 text-slate-200 text-xs leading-relaxed outline-none transition-all resize-none overflow-hidden ${
                                item.isEdited ? 'border-amber-500/50 bg-amber-500/[0.02]' : 'border-white/5 hover:border-white/10 focus:border-blue-500/30'
                              }`}
                              rows={Math.max(1, (item.target.match(/\n/g) || []).length + 1)}
                              value={item.target}
                              onChange={(e) => handleManualEdit(item.id, e.target.value)}
                              spellCheck={false}
                            />
                            <div className="flex items-center justify-between mt-1.5 min-h-[16px]">
                                <div className="flex flex-col gap-1 flex-1">
                                    {item.validationNote && (
                                      <p className="text-[9px] text-amber-500/70 italic leading-snug border-l border-amber-500/30 pl-2 mt-1 animate-slide-up">
                                        {item.validationNote}
                                      </p>
                                    )}
                                    {item.isEdited && (
                                      <button 
                                        onClick={() => reValidateItem(item.id)} 
                                        className="w-fit text-[8px] font-black uppercase tracking-widest text-amber-500 hover:text-emerald-500 flex items-center gap-1 transition-colors px-2 py-1 rounded bg-amber-500/10 hover:bg-emerald-500/10"
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                                        Перевалідувати правку
                                      </button>
                                    )}
                                </div>
                                {(item.status === 'done' || item.status === 'cached') && !glossary[item.source.trim()] && (
                                  <button onClick={() => addToGlossary(item.source.trim(), item.target!)} className="text-[8px] font-black uppercase tracking-widest text-slate-500 hover:text-blue-400 flex items-center gap-1 opacity-0 group-hover/edit:opacity-100 transition-all">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                                    В глосарій
                                  </button>
                                )}
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2 p-2">
                             <div className="w-1.5 h-1.5 rounded-full bg-blue-500/20 animate-pulse"></div>
                             <div className="w-1.5 h-1.5 rounded-full bg-blue-500/20 animate-pulse delay-75"></div>
                             <div className="w-1.5 h-1.5 rounded-full bg-blue-500/20 animate-pulse delay-150"></div>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-4 align-top text-right">
                       <div className="flex flex-col items-end gap-2">
                        <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-md tracking-widest border transition-all ${
                            item.status === 'done' ? 'bg-emerald-500/5 text-emerald-500 border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.05)]' :
                            item.status === 'cached' ? 'bg-blue-500/5 text-blue-400 border-blue-500/20' :
                            item.status === 'failed' ? 'bg-red-500/5 text-red-500 border-red-500/20' :
                            item.status === 'processing' ? 'bg-blue-500/10 text-blue-300 border-blue-500/30' : 'bg-white/5 text-slate-600 border-white/5'
                        }`}>
                          {item.status === 'done' ? 'Ready' : item.status === 'cached' ? 'Cached' : item.status === 'failed' ? 'Error' : item.status === 'processing' ? 'Sync' : 'Wait'}
                        </span>
                        {item.confidence !== undefined && (
                          <div className="w-12 mt-1 animate-pop">
                            <div className="flex justify-between w-full mb-1">
                              <span className={`text-[9px] font-bold ${item.confidence > 85 ? 'text-emerald-500' : 'text-amber-500'}`}>{item.confidence}%</span>
                            </div>
                            <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden">
                              <div className={`h-full transition-all duration-1000 ${item.confidence > 85 ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${item.confidence}%` }}></div>
                            </div>
                          </div>
                        )}
                       </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* ПРАВА ПАНЕЛЬ */}
      <aside className="w-[320px] flex flex-col h-full overflow-hidden">
        <div className="glass rounded-3xl p-6 h-full flex flex-col shadow-2xl border border-white/5 relative overflow-hidden">
           <header className="flex justify-between items-center mb-6 shrink-0">
              <div className="flex items-center gap-2">
                 <div className="w-1.5 h-4 bg-blue-500 rounded-sm"></div>
                 <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Проєкти в черзі</h2>
              </div>
              <button 
                onClick={downloadAll}
                className="text-[8px] font-bold text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 px-2 py-1 rounded transition-colors uppercase tracking-widest"
              >
                Скачати все
              </button>
           </header>

           <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar min-h-0">
              {fileQueue.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 opacity-10 border-2 border-dashed border-white/5 rounded-2xl animate-pulse">
                  <p className="text-[9px] font-black uppercase tracking-widest text-center px-4 leading-relaxed">Очікування CSV даних...</p>
                </div>
              )}
              {fileQueue.map((file, idx) => (
                <div 
                    key={`${file.name}-${idx}`} 
                    className={`group p-4 rounded-xl border transition-all duration-500 animate-slide-up ${
                        idx === currentFileIndex 
                        ? 'bg-blue-500/10 border-blue-500/30 ring-2 ring-blue-500/10 active-sync-pulse' 
                        : 'bg-white/[0.01] border-white/5 hover:border-white/10'
                    }`}
                    style={{ animationDelay: `${idx * 0.05}s` }}
                >
                  <div className="flex justify-between items-start mb-2.5">
                    <div className="max-w-[140px]">
                      <p className={`text-[11px] font-bold truncate transition-colors duration-300 ${idx === currentFileIndex ? 'text-blue-300' : 'text-slate-300'}`}>{file.name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-[9px] text-slate-600 font-bold uppercase tracking-tight">{file.completedItems || 0} / {file.totalItems || '?'} рядків</p>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-1">
                      {/* Reorder controls */}
                      {!isProcessing && (
                        <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity mr-2">
                           <button onClick={() => moveFile(idx, -1)} disabled={idx === 0} className="text-slate-600 hover:text-slate-300 disabled:opacity-20">
                             <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                           </button>
                           <button onClick={() => moveFile(idx, 1)} disabled={idx === fileQueue.length - 1} className="text-slate-600 hover:text-slate-300 disabled:opacity-20">
                             <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                           </button>
                        </div>
                      )}

                      {file.status === 'done' ? (
                        <button onClick={() => downloadFile(file.name)} className="w-8 h-8 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500 hover:text-white rounded-lg flex items-center justify-center transition-all animate-pop border border-emerald-500/20">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        </button>
                      ) : file.status === 'processing' ? (
                        <div className="w-5 h-5 border-2 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
                      ) : (
                        <span className="text-[8px] font-bold text-slate-700 bg-white/5 px-2 py-0.5 rounded uppercase tracking-widest">Wait</span>
                      )}
                    </div>
                  </div>
                  <div className="w-full bg-white/5 h-[3px] rounded-full overflow-hidden">
                    <div 
                      className={`h-full progress-bar-transition ${file.status === 'done' ? 'bg-emerald-500' : 'bg-blue-500'}`} 
                      style={{ width: `${file.progress}%` }}
                    ></div>
                  </div>
                </div>
              ))}
           </div>

           <footer className="mt-6 pt-6 border-t border-white/5 shrink-0">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Прогрес сесії</p>
                <span className="text-xs font-bold text-white font-mono">{sessionPercentage}%</span>
              </div>
              <div className="w-full bg-slate-950 h-3 rounded-full overflow-hidden p-[2px] border border-white/5">
                <div 
                    className="h-full bg-gradient-to-r from-blue-600 to-indigo-500 rounded-full progress-bar-transition shadow-[0_0_10px_rgba(59,130,246,0.3)]" 
                    style={{ width: `${sessionPercentage}%` }}
                ></div>
              </div>
           </footer>
        </div>
      </aside>
    </div>
  );
};

export default App;
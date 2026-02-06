
import React, { useState } from 'react';

interface GlossaryManagerProps {
  glossary: Record<string, string>;
  onUpdate: (newGlossary: Record<string, string>) => void;
}

const GlossaryManager: React.FC<GlossaryManagerProps> = ({ glossary, onUpdate }) => {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const addEntry = () => {
    if (newKey && newValue) {
      onUpdate({ ...glossary, [newKey]: newValue });
      setNewKey('');
      setNewValue('');
    }
  };

  const removeEntry = (key: string) => {
    const updated = { ...glossary };
    delete updated[key];
    onUpdate(updated);
  };

  return (
    <div className="glass rounded-2xl p-5 flex flex-col h-full shadow-2xl overflow-hidden relative group border border-white/5">
      <header className="flex items-center justify-between mb-5 shrink-0">
        <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
          Глосарій
        </h2>
        <span className="text-[9px] font-mono text-slate-600 bg-white/5 px-2 py-0.5 rounded-md border border-white/5">
          {Object.keys(glossary).length}
        </span>
      </header>
      
      <div className="space-y-2 mb-6 shrink-0">
        <div className="grid grid-cols-1 gap-2">
          <input 
            type="text" 
            placeholder="Оригінал (EN)"
            className="bg-white/[0.02] border border-white/5 rounded-xl px-3 py-2.5 text-[11px] outline-none focus:border-blue-500/30 focus:bg-blue-500/[0.01] transition-all placeholder:text-slate-700 text-slate-200"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input 
            type="text" 
            placeholder="Переклад (UA)"
            className="bg-white/[0.02] border border-white/5 rounded-xl px-3 py-2.5 text-[11px] outline-none focus:border-blue-500/30 focus:bg-blue-500/[0.01] transition-all placeholder:text-slate-700 text-slate-200"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
          />
        </div>
        <button 
          onClick={addEntry}
          className="w-full bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all active:scale-[0.97] border border-white/5"
        >
          Додати запис
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar min-h-0">
        {Object.entries(glossary).sort((a,b) => a[0].localeCompare(b[0])).map(([en, uk]) => (
          <div 
            key={en} 
            className="animate-slide-up flex justify-between items-center bg-white/[0.01] p-3 rounded-xl border border-white/[0.02] hover:border-white/10 group/item transition-all"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[9px] text-blue-400/80 font-bold uppercase tracking-tight truncate">{en}</span>
              <span className="text-[11px] text-slate-300 font-medium truncate">{uk}</span>
            </div>
            <button 
              onClick={() => removeEntry(en)}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-slate-700 hover:text-red-500 opacity-0 group-hover/item:opacity-100 transition-all border border-transparent hover:border-red-500/20"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default GlossaryManager;

import { useId, useState } from 'react'
import type { HistoricalPatternOption } from './existing-series'

export function HistoricalNamePicker({ options, value, onSelect }: {
  options: HistoricalPatternOption[]; value: string; onSelect(name: string): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const id = useId()
  const filtered = options.filter(option => option.name.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="history-name-picker">
    <button className="history-name-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span>{open ? '收起历史图案' : `从 ${options.length} 个历史图案中选择名称`}</span><span aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
    {open && <div id={id} className="history-name-options">
      <input type="search" aria-label="搜索历史图案名称" placeholder="搜索历史名称" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="history-name-grid">{filtered.map(option => <button type="button" key={option.id} aria-pressed={value === option.name} title={option.name} onClick={() => { onSelect(option.name); setOpen(false); setQuery('') }}>
        <img src={option.imageDataUrl} alt={option.name} loading="lazy" decoding="async" /><span>{option.name}</span>
      </button>)}{filtered.length === 0 && <p>未找到该名称，可清空搜索后看图选择。</p>}</div>
    </div>}
  </div>
}

import { useState } from 'react';
import { REQUEST_METHODS } from '../types';
import { PRESETS } from '../samples';

interface Props {
  method: string;
  url: string;
  onMethodChange: (m: string) => void;
  onUrlChange: (u: string) => void;
  onRun: () => void;
}

export function Simulator({ method, url, onMethodChange, onUrlChange, onRun }: Props) {
  const [touched, setTouched] = useState(false);
  const invalid = touched && url.trim() === '';

  return (
    <section className="panel">
      <h2>模拟请求</h2>
      <form
        className="sim-form"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (url.trim() !== '') onRun();
        }}
      >
        <select value={method} onChange={(e) => onMethodChange(e.target.value)}>
          {REQUEST_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className={invalid ? 'invalid' : ''}
          value={url}
          placeholder="http://api.example.com/v1/users/42"
          spellCheck={false}
          onChange={(e) => onUrlChange(e.target.value)}
        />
        <button type="submit" className="primary">
          运行
        </button>
      </form>
      {invalid && <div className="banner error">请输入待模拟的 URL</div>}
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="chip"
            title={p.url}
            onClick={() => {
              onMethodChange(p.method);
              onUrlChange(p.url);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}

import { h, Component } from 'preact';
import { convertFiles } from 'client/lazy-app/core/convert';
import type { BatchOptions } from 'client/lazy-app/core/convert';

type ItemStatus = 'pending' | 'processing' | 'done' | 'error';

interface Item {
  file: File;
  status: ItemStatus;
  message?: string;
  downloadUrl?: string;
  outputFile?: File;
}

interface State {
  items: Item[];
  running: boolean;
  done: number;
  total: number;
  encoder: 'mozJPEG' | 'webP' | 'avif';
  quality: number; // 0-100
}

export default class SimpleApp extends Component<{}, State> {
  state: State = { items: [], running: false, done: 0, total: 0, encoder: 'mozJPEG', quality: 75 };

  private ac?: AbortController;

  componentWillUnmount(): void {
    if (this.ac) this.ac.abort();
    for (const it of this.state.items) if (it.downloadUrl) URL.revokeObjectURL(it.downloadUrl);
  }

  private onSelectFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const items: Item[] = Array.from(files).map((f) => ({ file: f, status: 'pending' }));
    this.setState({ items, done: 0, total: items.length }, () => this.start());
  };

  private onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    const files = ev.dataTransfer?.files || null;
    this.onSelectFiles(files);
  };

  private onDragOver = (ev: DragEvent) => {
    ev.preventDefault();
  };

  private async start() {
    if (this.state.running || this.state.items.length === 0) return;
    const items = this.state.items.map((it) => ({ ...it, status: 'processing', message: 'Converting…' }));
    this.setState({ running: true, items });

    this.ac = new AbortController();

    const batchOpts: BatchOptions = {
      encoder: this.state.encoder,
      encoderOptions: this.getEncoderOptions(this.state.encoder, this.state.quality),
      concurrency: 2,
  onProgress: (done: number, total: number) => this.setState({ done, total }),
    } as any;

    try {
      const results = await convertFiles(
        this.state.items.map((it) => it.file),
        batchOpts,
        this.ac.signal,
      );

      const nextItems = this.state.items.map((it, i) => {
        const res = results[i];
        if (!res) return { ...it, status: 'error', message: 'Failed' } as Item;
        const url = URL.createObjectURL(res.output);
        return { ...it, status: 'done', message: 'Done', downloadUrl: url, outputFile: res.output } as Item;
      });
      this.setState({ items: nextItems, running: false });
    } catch (err) {
      // canceled or failed
      this.setState({ running: false });
    }
  }

  private cancel = () => {
    this.ac?.abort();
    this.setState({ running: false });
  };

  private getEncoderOptions(encoder: State['encoder'], quality: number): any {
    // 各エンコーダの主要な品質パラメータだけを上書き
    if (encoder === 'mozJPEG') {
      return { quality, progressive: true, optimize_coding: true };
    }
    if (encoder === 'webP') {
      return { quality, method: 4, lossless: 0 };
    }
    // avif
    return { quality, speed: 6 };
  }

  private onEncoderChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value as State['encoder'];
    this.setState({ encoder: value });
  };

  private onQualityChange = (e: Event) => {
    const value = Number((e.target as HTMLInputElement).value) || 0;
    this.setState({ quality: value });
  };

  private downloadZip = async () => {
    const { items } = this.state;
    const outputs = items.filter((it) => it.outputFile);
    if (outputs.length === 0) return;
    const { zipSync } = await import('fflate');
    const files: Record<string, Uint8Array> = {};
    for (const it of outputs) {
      const f = it.outputFile!;
      const buf = new Uint8Array(await f.arrayBuffer());
      let name = f.name;
      // 重複があれば連番付与
      let i = 1;
      while (files[name]) {
        const dot = f.name.lastIndexOf('.');
        const base = dot > 0 ? f.name.slice(0, dot) : f.name;
        const ext = dot > 0 ? f.name.slice(dot) : '';
        name = `${base} (${i++})${ext}`;
      }
      files[name] = buf;
    }
    const zipped = zipSync(files, { level: 6 });
    const blob = new Blob([zipped], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'images.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  render(_: {}, { items, running, done, total }: State) {
    const boxStyle: any = {
      border: '2px dashed #000',
      padding: '24px',
      textAlign: 'center',
      cursor: 'pointer',
      color: '#000',
      background: '#fff',
    };
    const pageStyle: any = {
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      color: '#000',
      background: '#fff',
      minHeight: '100vh',
      margin: 0,
      padding: '24px',
    };
    const listStyle: any = { listStyle: 'none', padding: 0 };
    const rowStyle: any = { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: '1px solid #000' };
    const nameStyle: any = { width: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const btnStyle: any = { padding: '6px 12px', border: '1px solid #000', background: '#fff', color: '#000', borderRadius: 0, textDecoration: 'none' };

    return (
      <div style={pageStyle}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 16px' }}>Simple Image Converter</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
          <label>
            Encoder:
            <select value={this.state.encoder} onChange={this.onEncoderChange as any} style={{ marginLeft: '6px' }}>
              <option value="mozJPEG">MozJPEG</option>
              <option value="webP">WebP</option>
              <option value="avif">AVIF</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            Quality:
            <input type="range" min="0" max="100" value={this.state.quality} onInput={this.onQualityChange as any} />
            <span>{this.state.quality}</span>
          </label>
          {items.some((it) => it.outputFile) && (
            <button style={btnStyle} onClick={this.downloadZip}>Download ZIP</button>
          )}
        </div>
        <div
          style={boxStyle}
          onDrop={this.onDrop as any}
          onDragOver={this.onDragOver as any}
          onClick={() => (document.getElementById('file-input') as HTMLInputElement)?.click()}
        >
          <div>Drop files here or click to select</div>
          <input
            id="file-input"
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => this.onSelectFiles((e.target as HTMLInputElement).files)}
          />
        </div>

        {total > 0 && (
          <div style={{ marginTop: '12px' }}>
            <span>Progress: {done}/{total}</span>
            {running && (
              <button style={{ ...btnStyle, marginLeft: '12px' }} onClick={this.cancel}>Cancel</button>
            )}
          </div>
        )}

        <ul style={{ ...listStyle, marginTop: '16px' }}>
          {items.map((it) => (
            <li style={rowStyle}>
              <div style={nameStyle} title={it.file.name}>{it.file.name}</div>
              <div style={{ flex: 1 }}>{it.message || it.status}</div>
              {it.downloadUrl && (
                <a href={it.downloadUrl} download style={btnStyle}>Download</a>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }
}

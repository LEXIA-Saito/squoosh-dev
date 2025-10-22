import { h, Component } from 'preact';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import WorkerBridge from '../worker-bridge';
import { encoderMap } from '../feature-meta';
import { abortable, builtinDecode, canDecodeImageType, sniffMimeType, assertSignal, blobToText, ImageMimeTypes } from '../util';
import { drawableToImageData } from '../util/canvas';

interface Props {
  files: File[];
  showSnack: SnackBarElement['showSnackbar'];
  onBack: () => void;
}

interface ItemState {
  file: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  downloadUrl?: string;
  message?: string;
}

interface State {
  items: ItemState[];
  running: boolean;
}

async function decodeImage(signal: AbortSignal, blob: Blob, worker: WorkerBridge): Promise<ImageData> {
  assertSignal(signal);
  const mimeType = await abortable(signal, sniffMimeType(blob));
  const canDecode = await abortable(signal, canDecodeImageType(mimeType));

  try {
    if (!canDecode) {
      if (mimeType === 'image/avif') return await worker.avifDecode(signal, blob);
      if (mimeType === 'image/webp') return await worker.webpDecode(signal, blob);
      if (mimeType === 'image/jxl') return await worker.jxlDecode(signal, blob);
      if (mimeType === 'image/webp2') return await worker.wp2Decode(signal, blob);
      if (mimeType === 'image/qoi') return await worker.qoiDecode(signal, blob);
      if (mimeType === 'image/svg+xml') {
        // Ensure SVG has width/height
        const parser = new DOMParser();
        const text = await abortable(signal, blobToText(blob));
        const document = parser.parseFromString(text, 'image/svg+xml');
        const svg = document.documentElement!;
        if (!svg.hasAttribute('width') || !svg.hasAttribute('height')) {
          const viewBox = svg.getAttribute('viewBox');
          if (viewBox) {
            const parts = viewBox.split(/\s+/);
            svg.setAttribute('width', parts[2]);
            svg.setAttribute('height', parts[3]);
          }
        }
        const serializer = new XMLSerializer();
        const newSource = serializer.serializeToString(document);
        const imgBlob = new Blob([newSource], { type: 'image/svg+xml' });
        const img = await abortable(signal, createImageBitmap(imgBlob));
        return drawableToImageData(img as any);
      }
    }
    return await builtinDecode(signal, blob);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw Error("Couldn't decode image");
  }
}

export default class Batch extends Component<Props, State> {
  state: State = {
    items: [],
    running: false,
  };

  private abortController = new AbortController();

  componentDidMount(): void {
    const items: ItemState[] = this.props.files.map((f) => ({ file: f, status: 'pending' }));
    this.setState({ items }, () => this.start());
  }

  componentWillUnmount(): void {
    this.abortController.abort();
    // Revoke URLs
    for (const it of this.state.items) {
      if (it.downloadUrl) URL.revokeObjectURL(it.downloadUrl);
    }
  }

  private async start() {
    if (this.state.running) return;
    this.setState({ running: true });

    const concurrency = Math.min(2, Math.max(1, (navigator as any).hardwareConcurrency || 2));

    const queue = [...this.state.items.keys()];
    const workers = Array.from({ length: concurrency }, () => new WorkerBridge());

    const runWorker = async (workerIndex: number) => {
      const worker = workers[workerIndex];
      while (queue.length) {
        const idx = queue.shift()!;
        await this.processOne(idx, worker).catch((err) => {
          console.error(err);
        });
      }
    };

    await Promise.all(workers.map((_, i) => runWorker(i)));

    this.setState({ running: false });
  }

  private async processOne(index: number, worker: WorkerBridge) {
    const controller = this.abortController;
    const signal = controller.signal;

    this.setState((s) => ({
      items: s.items.map((it, i) => (i === index ? { ...it, status: 'processing', message: 'Decoding…' } : it)),
    }));

    const srcFile = this.state.items[index].file;
    let decoded: ImageData;
    try {
      decoded = await decodeImage(signal, srcFile, worker);
    } catch (err) {
      this.fail(index, `Decode failed`);
      return;
    }

    this.setState((s) => ({
      items: s.items.map((it, i) => (i === index ? { ...it, message: 'Encoding (mozJPEG)…' } : it)),
    }));

    // Use mozJPEG defaults for batch
    const encoder = encoderMap.mozJPEG;
    try {
      const blob = await encoder.encode(
        signal,
        worker,
        decoded,
        encoder.meta.defaultOptions as any,
      );
      const type: ImageMimeTypes = encoder.meta.mimeType as ImageMimeTypes;
      const outFile = new File(
        [blob],
        srcFile.name.replace(/\.[^.]*$/, `.${encoder.meta.extension}`),
        { type },
      );
      const url = URL.createObjectURL(outFile);
      this.setState((s) => ({
        items: s.items.map((it, i) => (i === index ? { ...it, status: 'done', downloadUrl: url, message: 'Done' } : it)),
      }));
    } catch (err) {
      this.fail(index, `Encode failed`);
    }
  }

  private fail(index: number, message: string) {
    this.setState((s) => ({
      items: s.items.map((it, i) => (i === index ? { ...it, status: 'error', message } : it)),
    }));
    this.props.showSnack(message);
  }

  render({ onBack }: Props, { items, running }: State) {
    return (
      <div class="batch">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={onBack}>Back</button>
          <h2 style={{ margin: 0 }}>Batch convert ({items.length})</h2>
          {running && <span>Processing…</span>}
        </div>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((it) => (
            <li style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <div style={{ width: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.file.name}>{it.file.name}</div>
              <div style={{ flex: 1 }}>{it.message || it.status}</div>
              {it.downloadUrl && (
                <a href={it.downloadUrl} download style={{ padding: '6px 12px', background: '#4a4aef', color: '#fff', borderRadius: '6px', textDecoration: 'none' }}>Download</a>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }
}

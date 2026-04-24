import { useRef, useState } from 'preact/hooks'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import './app.css'

type ResultItem = {
  name: string
  url: string
  originalSize: number
  outputSize: number
  maxVolumeText: string
  gainText: string
}

const TARGET_PEAK_DB = -3.0

function getExt(name: string): string {
  const m = name.match(/\.([^.]+)$/)
  return m ? m[1].toLowerCase() : 'bin'
}

function getStem(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

function safeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120)
}

function parseMaxVolume(logText: string): number | null {
  const m = logText.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i)
  if (!m) return null
  return Number(m[1])
}

export function App() {
  const ffmpegRef = useRef(new FFmpeg())
  const loadedRef = useRef(false)
  const logLinesRef = useRef<string[]>([])

  const [status, setStatus] = useState('待機中')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ResultItem[]>([])
  const [useLimiter, setUseLimiter] = useState(false)

  async function loadFFmpeg() {
    if (loadedRef.current) return

    setStatus('ffmpeg.wasm を読み込み中... 初回は時間がかかります')

    const ffmpeg = ffmpegRef.current

    ffmpeg.on('log', ({ message }) => {
      logLinesRef.current.push(message)
      console.log(message)

      if (message.includes('max_volume')) {
        setStatus(message)
      }
    })

    // Viteでは esm 側を使う
    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'

    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    })

    loadedRef.current = true
    setStatus('ffmpeg.wasm 読み込み完了')
  }

  async function detectPeak(inputName: string): Promise<number | null> {
    const ffmpeg = ffmpegRef.current
    logLinesRef.current = []

    await ffmpeg.exec([
      '-i',
      inputName,
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ])

    return parseMaxVolume(logLinesRef.current.join('\n'))
  }

  async function convertOne(file: File, index: number): Promise<ResultItem> {
    const ffmpeg = ffmpegRef.current

    const ext = getExt(file.name)
    const stem = safeName(getStem(file.name))
    const inputName = `input_${index}.${ext}`
    const outputName = `${stem}.m4a`

    setStatus(`入力中: ${file.name}`)
    await ffmpeg.writeFile(inputName, await fetchFile(file))

    setStatus(`ピーク検出中: ${file.name}`)
    const maxVolume = await detectPeak(inputName)

    let gainDb = 0
    if (maxVolume !== null && maxVolume > TARGET_PEAK_DB) {
      gainDb = TARGET_PEAK_DB - maxVolume
    }

    const filterParts: string[] = []

    if (gainDb < 0) {
      filterParts.push(`volume=${gainDb.toFixed(2)}dB`)
    }

    if (useLimiter) {
      // 0.891 ≒ -1.0 dBFS 相当
      filterParts.push('alimiter=limit=0.891')
    }

    const args = [
      '-y',
      '-i',
      inputName,
      '-vn',
    ]

    if (filterParts.length > 0) {
      args.push('-af', filterParts.join(','))
    }

    args.push(
      '-c:a',
      'aac',
      '-profile:a',
      'aac_low',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outputName,
    )

    setStatus(`変換中: ${file.name}`)
    await ffmpeg.exec(args)

    const data = await ffmpeg.readFile(outputName)

	const bytes =
  typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(data)

const arrayBuffer = bytes.buffer.slice(
  bytes.byteOffset,
  bytes.byteOffset + bytes.byteLength,
) as ArrayBuffer

const blob = new Blob([arrayBuffer], { type: 'audio/mp4' })
const url = URL.createObjectURL(blob)

    try {
      await ffmpeg.deleteFile(inputName)
      await ffmpeg.deleteFile(outputName)
    } catch {
      // 削除失敗は無視
    }

    return {
      name: outputName,
      url,
      originalSize: file.size,
      outputSize: blob.size,
      maxVolumeText: maxVolume === null ? '検出失敗' : `${maxVolume.toFixed(2)} dB`,
      gainText: gainDb === 0 ? '変更なし' : `${gainDb.toFixed(2)} dB`,
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    setBusy(true)
    setResults([])

    try {
      await loadFFmpeg()

      const nextResults: ResultItem[] = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setStatus(`${i + 1}/${files.length}: ${file.name}`)
        const result = await convertOne(file, i)
        nextResults.push(result)
        setResults([...nextResults])
      }

      setStatus('完了')
    } catch (err) {
      console.error(err)
      setStatus(`エラー: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>AAC-LC 128k Peak Safe Converter</h1>

      <p>
        音声ファイルをブラウザ内で AAC-LC 128k の m4a に変換します。
      </p>

      <label class="option">
        <input
          type="checkbox"
          checked={useLimiter}
          onChange={(e) => setUseLimiter((e.currentTarget as HTMLInputElement).checked)}
          disabled={busy}
        />
        limiter を使う
      </label>

      <div class="box">
        <input
          type="file"
          accept="audio/*,.wav,.WAV,.m4a,.M4A,.mp3,.MP3,.flac,.FLAC,.aac,.AAC"
          multiple
          disabled={busy}
          onChange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
        />
      </div>

      <p class="status">{status}</p>

      {results.length > 0 && (
        <section>
          <h2>変換結果</h2>

          <ul>
            {results.map((r) => (
              <li key={r.url} class="result">
                <a href={r.url} download={r.name}>
                  {r.name}
                </a>
                <div>max_volume: {r.maxVolumeText}</div>
                <div>gain: {r.gainText}</div>
                <div>
                  {Math.round(r.originalSize / 1024 / 1024)} MB →{' '}
                  {Math.round(r.outputSize / 1024 / 1024)} MB
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
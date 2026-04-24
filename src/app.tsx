import { useEffect, useRef, useState } from 'preact/hooks'
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
  elapsedMs: number
}

type ProgressState = {
  fileName: string
  phase: string
  percent: number | null
  ffmpegTimeSec: number | null
}

type CacheInfo = {
  name: string
  entries: number
  sampleUrls: string[]
}

const TARGET_PEAK_DB = -3.0
const FFMPEG_CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'

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

function normalizeDateStemFromH2eLikeName(fileName: string): string | null {
  const stem = getStem(fileName)

  // 例: 251210_180347_MIX.wav -> 25-12-10.m4a
  // MIX以外も許容し、日付+時刻で始まる名前なら日付化する
  const m = stem.match(/^(\d{2})(\d{2})(\d{2})[_-]\d{6}(?:[_-].*)?$/)
  if (!m) return null

  return `${m[1]}-${m[2]}-${m[3]}`
}

function uniqueOutputName(baseStem: string, usedLowerNames: Set<string>): string {
  const safeBase = safeName(baseStem) || 'output'
  let candidate = `${safeBase}.m4a`
  let n = 2

  while (usedLowerNames.has(candidate.toLowerCase())) {
    candidate = `${safeBase}_${n}.m4a`
    n += 1
  }

  usedLowerNames.add(candidate.toLowerCase())
  return candidate
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`
}

function formatRequestUrl(urlText: string): string {
  try {
    const url = new URL(urlText)
    if (url.origin === location.origin) {
      return url.pathname
    }
    return `${url.hostname}${url.pathname}`
  } catch {
    return urlText
  }
}

export function App() {
  const ffmpegRef = useRef(new FFmpeg())
  const loadedRef = useRef(false)
  const logLinesRef = useRef<string[]>([])
  const lastProgressUpdateRef = useRef(0)
  const usedOutputNamesRef = useRef<Set<string>>(new Set())

  const [status, setStatus] = useState('待機中')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ResultItem[]>([])
  const [useLimiter, setUseLimiter] = useState(false)
  const [renameByDate, setRenameByDate] = useState(true)
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [cacheInfo, setCacheInfo] = useState<CacheInfo[]>([])
  const [cacheStatus, setCacheStatus] = useState('未確認')

  useEffect(() => {
    refreshCacheInfo()
  }, [])

  async function refreshCacheInfo() {
    if (!('caches' in window)) {
      setCacheStatus('このブラウザでは Cache Storage を利用できません')
      setCacheInfo([])
      return
    }

    try {
      const names = await caches.keys()
      const nextInfo: CacheInfo[] = []

      for (const name of names) {
        const cache = await caches.open(name)
        const keys = await cache.keys()

        nextInfo.push({
          name,
          entries: keys.length,
          sampleUrls: keys.slice(0, 6).map((request) => formatRequestUrl(request.url)),
        })
      }

      setCacheInfo(nextInfo)
      setCacheStatus(names.length === 0 ? 'キャッシュなし' : `${names.length} 個のキャッシュを検出`)
    } catch (err) {
      console.error(err)
      setCacheStatus(`キャッシュ確認エラー: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function clearAllCaches() {
    if (!('caches' in window)) {
      setCacheStatus('このブラウザでは Cache Storage を利用できません')
      return
    }

    try {
      const names = await caches.keys()
      await Promise.all(names.map((name) => caches.delete(name)))
      setCacheInfo([])
      setCacheStatus(`${names.length} 個のキャッシュを削除しました`)
    } catch (err) {
      console.error(err)
      setCacheStatus(`キャッシュ削除エラー: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

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

    ffmpeg.on('progress', ({ progress: rawProgress, time }) => {
      const now = Date.now()
      const normalizedProgress = Number.isFinite(rawProgress)
        ? Math.max(0, Math.min(1, rawProgress))
        : null

      if (now - lastProgressUpdateRef.current < 250 && normalizedProgress !== 1) {
        return
      }

      lastProgressUpdateRef.current = now

      setProgress((prev) => ({
        fileName: prev?.fileName ?? '',
        phase: prev?.phase ?? '変換中',
        percent: normalizedProgress === null ? null : Math.round(normalizedProgress * 1000) / 10,
        ffmpegTimeSec: Number.isFinite(time) ? time / 1_000_000 : null,
      }))
    })

    await ffmpeg.load({
      coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    })

    loadedRef.current = true
    setStatus('ffmpeg.wasm 読み込み完了')
    await refreshCacheInfo()
  }

  async function detectPeak(inputName: string, displayFileName: string): Promise<number | null> {
    const ffmpeg = ffmpegRef.current
    logLinesRef.current = []

    setProgress({
      fileName: displayFileName,
      phase: 'ピーク検出中',
      percent: null,
      ffmpegTimeSec: null,
    })

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

  function makeOutputName(file: File): string {
    const normalizedDateStem = renameByDate ? normalizeDateStemFromH2eLikeName(file.name) : null
    const baseStem = normalizedDateStem ?? getStem(file.name)
    return uniqueOutputName(baseStem, usedOutputNamesRef.current)
  }

  async function convertOne(file: File, index: number): Promise<ResultItem> {
    const startedAt = performance.now()
    const ffmpeg = ffmpegRef.current

    const ext = getExt(file.name)
    const inputName = `input_${index}.${ext}`
    const outputName = makeOutputName(file)

    setStatus(`入力中: ${file.name}`)
    setProgress({
      fileName: file.name,
      phase: '入力中',
      percent: null,
      ffmpegTimeSec: null,
    })
    await ffmpeg.writeFile(inputName, await fetchFile(file))

    setStatus(`ピーク検出中: ${file.name}`)
    const maxVolume = await detectPeak(inputName, file.name)

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
    setProgress({
      fileName: file.name,
      phase: '変換中',
      percent: 0,
      ffmpegTimeSec: null,
    })

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

    const elapsedMs = performance.now() - startedAt

    return {
      name: outputName,
      url,
      originalSize: file.size,
      outputSize: blob.size,
      maxVolumeText: maxVolume === null ? '検出失敗' : `${maxVolume.toFixed(2)} dB`,
      gainText: gainDb === 0 ? '変更なし' : `${gainDb.toFixed(2)} dB`,
      elapsedMs,
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    setBusy(true)
    results.forEach((result) => URL.revokeObjectURL(result.url))
    setResults([])
    usedOutputNamesRef.current = new Set()

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

      setProgress(null)
      setStatus('完了')
      await refreshCacheInfo()
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

      <section class="box">
        <label class="option">
          <input
            type="checkbox"
            checked={renameByDate}
            onChange={(e) => setRenameByDate((e.currentTarget as HTMLInputElement).checked)}
            disabled={busy}
          />
          H2e形式の名前を日付にリネームする（例: 251210_180347_MIX.wav → 25-12-10.m4a）
        </label>

        <label class="option">
          <input
            type="checkbox"
            checked={useLimiter}
            onChange={(e) => setUseLimiter((e.currentTarget as HTMLInputElement).checked)}
            disabled={busy}
          />
          limiter を使う
        </label>
      </section>

      <section class="box">
        <input
          type="file"
          accept="audio/*,.wav,.WAV,.m4a,.M4A,.mp3,.MP3,.flac,.FLAC,.aac,.AAC"
          multiple
          disabled={busy}
          onChange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
        />
      </section>

      <p class="status">{status}</p>

      {progress && (
        <section class="box">
          <h2>進行状況</h2>
          <div>対象: {progress.fileName || '-'}</div>
          <div>工程: {progress.phase}</div>
          <div>
            進行: {progress.percent === null ? '計算中' : `${progress.percent.toFixed(1)} %`}
          </div>
          {progress.percent !== null && (
            <progress value={progress.percent} max="100" />
          )}
          <div>
            ffmpeg time:{' '}
            {progress.ffmpegTimeSec === null ? '-' : `${progress.ffmpegTimeSec.toFixed(1)} 秒`}
          </div>
        </section>
      )}

      <section class="box">
        <h2>キャッシュ</h2>
        <div class="buttonRow">
          <button type="button" onClick={refreshCacheInfo} disabled={busy}>
            キャッシュ表示更新
          </button>
          <button type="button" onClick={clearAllCaches} disabled={busy}>
            全キャッシュ削除
          </button>
        </div>
        <p class="cacheStatus">{cacheStatus}</p>

        {cacheInfo.length > 0 && (
          <ul>
            {cacheInfo.map((item) => (
              <li key={item.name} class="cacheItem">
                <strong>{item.name}</strong>
                <div>{item.entries} 件</div>
                {item.sampleUrls.length > 0 && (
                  <ul class="sampleUrls">
                    {item.sampleUrls.map((url) => (
                      <li key={url}>{url}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

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
                  {formatBytes(r.originalSize)} → {formatBytes(r.outputSize)}
                </div>
                <div>処理時間: {formatSeconds(r.elapsedMs)}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}

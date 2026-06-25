import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

/**
 * Player HLS ao vivo para uma única câmera.
 * O stream é sob demanda e pode levar ~5-8s pra subir, então fazemos
 * retry com backoff enquanto ainda não há manifesto.
 * Props:
 *  - slug:  slug da câmera -> /hls/<slug>/index.m3u8
 *  - name:  nome de exibição (opcional, acessibilidade)
 */
export default function CameraTile({ slug, name }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  // status: 'loading' | 'live' | 'error'
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !slug) return;

    const src = `/hls/${slug}/index.m3u8`;
    let destroyed = false;
    let retryTimer = null;
    let retries = 0;
    const MAX_RETRIES = 12; // ~ até 12 tentativas durante a subida do stream

    const markLive = () => {
      if (!destroyed) {
        retries = 0;
        setStatus('live');
      }
    };

    const scheduleRetry = (restartFn) => {
      if (destroyed) return;
      if (retries >= MAX_RETRIES) {
        setStatus('error');
        return;
      }
      retries += 1;
      setStatus('loading');
      const delay = Math.min(1500 + retries * 600, 5000);
      retryTimer = setTimeout(() => {
        if (!destroyed) restartFn();
      }, delay);
    };

    // --- HLS nativo (Safari / iOS) ---
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      const start = () => {
        video.src = src;
        video.load();
      };
      const onLoaded = () => markLive();
      const onErr = () => scheduleRetry(start);
      const tryPlay = () => video.play().catch(() => {});

      video.addEventListener('loadeddata', onLoaded);
      video.addEventListener('error', onErr);
      video.addEventListener('canplay', tryPlay);
      start();

      return () => {
        destroyed = true;
        if (retryTimer) clearTimeout(retryTimer);
        video.removeEventListener('loadeddata', onLoaded);
        video.removeEventListener('error', onErr);
        video.removeEventListener('canplay', tryPlay);
        video.removeAttribute('src');
        video.load();
      };
    }

    // --- hls.js (demais navegadores) ---
    if (Hls.isSupported()) {
      const buildHls = () => {
        const hls = new Hls({
          lowLatencyMode: true,
          liveSyncDurationCount: 3,
          maxBufferLength: 10,
          manifestLoadingMaxRetry: 2,
          manifestLoadingRetryDelay: 800,
        });
        hlsRef.current = hls;

        hls.loadSource(src);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          markLive();
          video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // Tenta recuperar erro de mídia sem reiniciar do zero.
            try {
              hls.recoverMediaError();
              return;
            } catch {
              /* cai no restart abaixo */
            }
          }
          // Erro de rede (stream ainda não subiu) ou outro fatal: reinicia.
          try {
            hls.destroy();
          } catch {
            /* noop */
          }
          hlsRef.current = null;
          scheduleRetry(buildHls);
        });
      };

      buildHls();

      return () => {
        destroyed = true;
        if (retryTimer) clearTimeout(retryTimer);
        try {
          hlsRef.current?.destroy();
        } catch {
          /* noop */
        }
        hlsRef.current = null;
      };
    }

    // Sem suporte a HLS.
    setStatus('error');
    return () => {
      destroyed = true;
    };
  }, [slug]);

  return (
    <div className="tile-video">
      <video
        ref={videoRef}
        className={status === 'live' ? 'is-live' : 'is-hidden'}
        muted
        autoPlay
        playsInline
        controls={false}
        aria-label={name ? `Câmera ${name}` : 'Câmera'}
      />

      {status !== 'live' && (
        <div className={`tile-placeholder ${status}`}>
          {status === 'loading' ? (
            <>
              <div className="spinner small" />
              <span>Conectando…</span>
            </>
          ) : (
            <>
              <div className="no-signal-icon" aria-hidden="true">
                &#9888;
              </div>
              <span>Sem sinal</span>
            </>
          )}
        </div>
      )}

      <div className="live-badge" data-state={status}>
        <span className="dot" />
        {status === 'live' ? 'AO VIVO' : status === 'error' ? 'OFFLINE' : '…'}
      </div>
    </div>
  );
}

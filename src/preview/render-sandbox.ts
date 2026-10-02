import { READY_MESSAGE, RENDER_MESSAGE } from '@/lib/messages';
import type { ArtifactRenderer } from '@/platform/extension';

/** Render through a manifest sandbox page. Its opaque origin requires '*'
 * for this one outbound message; only the iframe we created can announce ready.
 * Browser entries supply the page URL and choose whether this strategy exists. */
export function sandboxRenderer(pageUrl: string): ArtifactRenderer {
  return (html, onReady) => {
    const frame = document.createElement('iframe');
    frame.id = 'artifact-frame';
    frame.title = 'Rendered HTML preview';
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.type !== READY_MESSAGE) return;
      frame.contentWindow?.postMessage({ type: RENDER_MESSAGE, html }, '*');
      window.removeEventListener('message', onMessage);
      onReady();
    };
    window.addEventListener('message', onMessage);
    frame.src = pageUrl;
    document.body.append(frame);
    return () => {
      window.removeEventListener('message', onMessage);
      frame.remove();
    };
  };
}

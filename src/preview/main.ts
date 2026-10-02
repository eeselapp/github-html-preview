import './style.css';
import { chromeResources } from '@/platform/chrome';
import { startPreview } from './app';
import { sandboxRenderer } from './render-sandbox';

const resources = chromeResources();
startPreview(resources, sandboxRenderer(resources.resourceUrl('src/sandbox/index.html')));

/** Browser-specific capabilities consumed by application code. All DOM,
 * GitHub routing, fetching, and preview state use ordinary Web APIs. */
export type Unsubscribe = () => void;

export interface ExtensionResources {
  readonly origin: string;
  resourceUrl(path: string): string;
}

export interface ContentPlatform extends ExtensionResources {
  readAutoOpen(): Promise<boolean>;
  writeAutoOpen(value: boolean): void;
  onAutoOpenChange(listener: (value: boolean) => void): Unsubscribe;
  onOpenPreview(listener: (url: string) => void): Unsubscribe;
}

export interface LinkMenu {
  id: string;
  title: string;
  targetUrlPatterns: string[];
  documentUrlPatterns: string[];
}

export interface LinkMenuClick {
  menuItemId: string | number;
  linkUrl?: string;
  tabId?: number;
}

export interface BackgroundPlatform {
  onInstalled(listener: () => void): Unsubscribe;
  replaceLinkMenu(menu: LinkMenu): Promise<void>;
  onLinkMenuClick(listener: (click: LinkMenuClick) => void): Unsubscribe;
  openPreviewInTab(tabId: number, url: string): Promise<void>;
}

/** A browser entry chooses the rendering strategy; the preview application
 * never assumes manifest sandbox support or a particular extension scheme. */
export type ArtifactRenderer = (html: string, onReady: () => void) => Unsubscribe;

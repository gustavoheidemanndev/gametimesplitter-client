import { DEFAULT_APP_LANGUAGE, supportedAppLanguages, type AppLanguage } from './overlay-theme';

/**
 * `spread` mantém o líder à esquerda e o delta à direita, que é a composição descrita em
 * docs/VIEWER_ASSISTIR_RACES.md. Os demais valores agrupam os dois textos de um lado só,
 * para quem encaixa a janela em um canto estreito da cena do OBS.
 */
export type ViewerOverlayAlignment = 'spread' | 'left' | 'center' | 'right';

/**
 * Tema da overlay de espectador. Vive só no disco local (`viewer-overlay-theme.json`): esta
 * janela não usa `UserLayout` nem `PUT /layouts/active`, então nada aqui é sincronizado.
 */
export interface ViewerOverlayTheme {
  fontFamily: string;
  timeFontFamily: string;
  fontWeight: number;
  timeFontWeight: number;
  nameFontSize: number;
  deltaFontSize: number;
  padding: number;
  borderRadius: number;
  backgroundColor: string;
  backgroundOpacity: number;
  borderColor: string;
  borderWidth: number;
  textColor: string;
  mutedColor: string;
  aheadColor: string;
  behindColor: string;
  alignment: ViewerOverlayAlignment;
  /** Delta sem centésimos, como o `compactTime` do tema do runner. */
  compactTime: boolean;
  language: AppLanguage;
}

export const defaultViewerOverlayTheme: ViewerOverlayTheme = {
  fontFamily: 'Segoe UI, Inter, system-ui, sans-serif',
  timeFontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
  fontWeight: 700,
  timeFontWeight: 800,
  nameFontSize: 20,
  deltaFontSize: 30,
  padding: 10,
  borderRadius: 0,
  backgroundColor: '#000000',
  backgroundOpacity: 0.88,
  borderColor: '#333333',
  borderWidth: 1,
  textColor: '#f2f2f2',
  mutedColor: '#b8b8b8',
  aheadColor: '#39d353',
  behindColor: '#e05252',
  alignment: 'spread',
  compactTime: false,
  language: DEFAULT_APP_LANGUAGE,
};

const viewerOverlayAlignments: ViewerOverlayAlignment[] = ['spread', 'left', 'center', 'right'];

export const sanitizeViewerOverlayTheme = (value: unknown): ViewerOverlayTheme => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<ViewerOverlayTheme>;
  const merged: ViewerOverlayTheme = { ...defaultViewerOverlayTheme, ...source };
  const clampNumber = (input: number, min: number, max: number, fallback: number): number => {
    const numeric = Number(input);
    return Number.isFinite(numeric) ? Math.min(Math.max(numeric, min), max) : fallback;
  };
  const clampColor = (input: string, fallback: string): string =>
    typeof input === 'string' && /^#[0-9a-fA-F]{6}$/.test(input) ? input : fallback;
  const clampFont = (input: string, fallback: string): string =>
    typeof input === 'string' && input.trim() ? input.trim().slice(0, 160) : fallback;

  return {
    fontFamily: clampFont(merged.fontFamily, defaultViewerOverlayTheme.fontFamily),
    timeFontFamily: clampFont(merged.timeFontFamily, defaultViewerOverlayTheme.timeFontFamily),
    fontWeight: clampNumber(merged.fontWeight, 100, 900, defaultViewerOverlayTheme.fontWeight),
    timeFontWeight: clampNumber(merged.timeFontWeight, 100, 900, defaultViewerOverlayTheme.timeFontWeight),
    nameFontSize: clampNumber(merged.nameFontSize, 8, 80, defaultViewerOverlayTheme.nameFontSize),
    deltaFontSize: clampNumber(merged.deltaFontSize, 8, 120, defaultViewerOverlayTheme.deltaFontSize),
    padding: clampNumber(merged.padding, 0, 60, defaultViewerOverlayTheme.padding),
    borderRadius: clampNumber(merged.borderRadius, 0, 40, defaultViewerOverlayTheme.borderRadius),
    backgroundColor: clampColor(merged.backgroundColor, defaultViewerOverlayTheme.backgroundColor),
    backgroundOpacity: clampNumber(merged.backgroundOpacity, 0, 1, defaultViewerOverlayTheme.backgroundOpacity),
    borderColor: clampColor(merged.borderColor, defaultViewerOverlayTheme.borderColor),
    borderWidth: clampNumber(merged.borderWidth, 0, 8, defaultViewerOverlayTheme.borderWidth),
    textColor: clampColor(merged.textColor, defaultViewerOverlayTheme.textColor),
    mutedColor: clampColor(merged.mutedColor, defaultViewerOverlayTheme.mutedColor),
    aheadColor: clampColor(merged.aheadColor, defaultViewerOverlayTheme.aheadColor),
    behindColor: clampColor(merged.behindColor, defaultViewerOverlayTheme.behindColor),
    alignment: viewerOverlayAlignments.includes(merged.alignment as ViewerOverlayAlignment)
      ? merged.alignment as ViewerOverlayAlignment
      : defaultViewerOverlayTheme.alignment,
    compactTime: typeof merged.compactTime === 'boolean'
      ? merged.compactTime
      : defaultViewerOverlayTheme.compactTime,
    language: supportedAppLanguages.includes(merged.language as AppLanguage)
      ? merged.language as AppLanguage
      : defaultViewerOverlayTheme.language,
  };
};

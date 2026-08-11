export type AppLanguage = 'en' | 'pt-BR' | 'es';
export type TimeAlignment = 'left' | 'center' | 'right';
export type LayoutOrientation = 'vertical' | 'horizontal';

export const supportedAppLanguages: AppLanguage[] = ['en', 'pt-BR', 'es'];
export const DEFAULT_APP_LANGUAGE: AppLanguage = 'en';
export type OverlayComponentType =
  | 'title'
  | 'splits'
  | 'timer'
  | 'previousSegment'
  | 'golds'
  | 'segmentPersonalBest'
  | 'sumOfBest'
  | 'personalBest'
  | 'attempts'
  | 'money'
  | 'chapterKills'
  | 'igt'
  | 'pauseBuffers'
  | 'separator';

export interface OverlayComponent {
  id: string;
  type: OverlayComponentType;
  label: string;
}

export const overlayComponentTypes: OverlayComponentType[] = [
  'title', 'splits', 'timer', 'previousSegment', 'golds', 'segmentPersonalBest',
  'sumOfBest', 'personalBest', 'attempts', 'money', 'chapterKills',
  'igt', 'pauseBuffers', 'separator',
];

export const overlayComponentLabelCatalogs: Record<AppLanguage, Record<OverlayComponentType, string>> = {
  en: {
    title: 'Title', splits: 'Splits', timer: 'Timer', previousSegment: 'Previous Segment',
    golds: 'Gold', segmentPersonalBest: 'Segment Personal Best', sumOfBest: 'Sum of Best',
    personalBest: 'Personal Best', attempts: 'Attempts', money: 'Money',
    chapterKills: 'Chapter Kills', igt: 'IGT', pauseBuffers: 'Pause Buffers', separator: 'Separator',
  },
  'pt-BR': {
    title: 'Título', splits: 'Splits', timer: 'Tempo', previousSegment: 'Segmento anterior',
    golds: 'Gold', segmentPersonalBest: 'Personal Best do segmento', sumOfBest: 'Soma dos melhores',
    personalBest: 'Personal Best', attempts: 'Tentativas', money: 'Dinheiro',
    chapterKills: 'Kills do capítulo', igt: 'IGT', pauseBuffers: 'Pause buffers', separator: 'Separador',
  },
  es: {
    title: 'Título', splits: 'Splits', timer: 'Tiempo', previousSegment: 'Segmento anterior',
    golds: 'Gold', segmentPersonalBest: 'Mejor marca personal del segmento', sumOfBest: 'Suma de los mejores',
    personalBest: 'Mejor marca personal', attempts: 'Intentos', money: 'Dinero',
    chapterKills: 'Bajas del capítulo', igt: 'IGT', pauseBuffers: 'Buffers de pausa', separator: 'Separador',
  },
};

export const overlayComponentLabelsByLanguage = overlayComponentLabelCatalogs;
export const overlayComponentLabels: Record<OverlayComponentType, string> =
  overlayComponentLabelCatalogs[DEFAULT_APP_LANGUAGE];

export const getOverlayComponentLabel = (
  type: OverlayComponentType,
  language: AppLanguage
): string => overlayComponentLabelCatalogs[language][type];

export const defaultOverlayComponents: OverlayComponent[] = [
  { id: 'title', type: 'title', label: 'Title' },
  { id: 'splits', type: 'splits', label: 'Splits' },
  { id: 'previous-segment', type: 'previousSegment', label: 'Previous Segment' },
  { id: 'timer', type: 'timer', label: 'Timer' },
  { id: 'sum-of-best', type: 'sumOfBest', label: 'Sum of Best' },
];

export interface OverlayTheme {
  fontFamily: string;
  timeFontFamily: string;
  fontWeight: number;
  timeFontWeight: number;
  baseFontSize: number;
  segmentFontSize: number;
  timeFontSize: number;
  gameFontSize: number;
  categoryFontSize: number;
  footerFontSize: number;
  padding: number;
  segmentPadding: number;
  segmentGap: number;
  sectionGap: number;
  borderRadius: number;
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  borderColor: string;
  borderWidth: number;
  textColor: string;
  mutedColor: string;
  accentColor: string;
  aheadColor: string;
  behindColor: string;
  goldColor: string;
  completedTimerColor: string;
  activeRowColor: string;
  timeAlignment: TimeAlignment;
  timeLetterSpacing: number;
  layoutOrientation: LayoutOrientation;
  language: AppLanguage;
  components: OverlayComponent[];
  showGame: boolean;
  showCategory: boolean;
  showSegments: boolean;
  showPhase: boolean;
  showFooter: boolean;
  showDeltas: boolean;
  showSegmentTime: boolean;
  /**
   * Cronômetro do segmento atual, abaixo do cronômetro principal, contando do zero.
   *
   * Desligado por padrão: ligar mudaria a altura da overlay de quem já tem um layout montado.
   */
  showSegmentTimer: boolean;
  compactTime: boolean;
  uppercaseCategory: boolean;
}

export const defaultOverlayTheme: OverlayTheme = {
  fontFamily: 'Segoe UI, Inter, system-ui, sans-serif',
  timeFontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
  fontWeight: 600,
  timeFontWeight: 800,
  baseFontSize: 13,
  segmentFontSize: 13,
  timeFontSize: 52,
  gameFontSize: 15,
  categoryFontSize: 11,
  footerFontSize: 11,
  padding: 8,
  segmentPadding: 4,
  segmentGap: 0,
  sectionGap: 2,
  borderRadius: 0,
  backgroundColor: '#000000',
  backgroundOpacity: 0.88,
  backgroundBlur: 0,
  borderColor: '#333333',
  borderWidth: 1,
  textColor: '#f2f2f2',
  mutedColor: '#b8b8b8',
  accentColor: '#2a80ff',
  aheadColor: '#39d353',
  behindColor: '#e05252',
  goldColor: '#ffd700',
  completedTimerColor: '#ffd700',
  activeRowColor: '#2a80ff',
  timeAlignment: 'right',
  timeLetterSpacing: -2,
  layoutOrientation: 'vertical',
  language: DEFAULT_APP_LANGUAGE,
  components: defaultOverlayComponents,
  showGame: true,
  showCategory: true,
  showSegments: true,
  showPhase: false,
  showFooter: true,
  showDeltas: true,
  showSegmentTime: true,
  showSegmentTimer: false,
  compactTime: false,
  uppercaseCategory: false,
};

export const overlayThemePresets: Record<string, OverlayTheme> = {
  default: defaultOverlayTheme,
  livesplit: defaultOverlayTheme,
  minimal: {
    ...defaultOverlayTheme,
    backgroundOpacity: 0,
    borderWidth: 0,
    padding: 4,
    sectionGap: 4,
    components: [
      { id: 'title', type: 'title', label: 'Title' },
      { id: 'timer', type: 'timer', label: 'Timer' },
    ],
    showPhase: false,
    showCategory: false,
    timeFontSize: 60,
  },
  classic: {
    ...defaultOverlayTheme,
    fontFamily: '"Courier New", monospace',
    timeFontFamily: '"Courier New", monospace',
    accentColor: '#2455a4',
    aheadColor: '#34c759',
    behindColor: '#d94747',
    activeRowColor: '#2455a4',
  },
  neon: {
    ...defaultOverlayTheme,
    backgroundColor: '#0a0221',
    backgroundOpacity: 0.78,
    backgroundBlur: 6,
    borderRadius: 10,
    sectionGap: 6,
    accentColor: '#ff4dd8',
    aheadColor: '#57f2ff',
    behindColor: '#ff5f8f',
    goldColor: '#ffe259',
    activeRowColor: '#ff4dd8',
    borderColor: '#ff4dd8',
  },
  paper: {
    ...defaultOverlayTheme,
    backgroundColor: '#faf6ee',
    backgroundOpacity: 0.94,
    borderColor: '#3c2f1e',
    textColor: '#211a10',
    mutedColor: '#6d5c45',
    accentColor: '#8a3d1a',
    aheadColor: '#2f7d3d',
    behindColor: '#a03030',
    goldColor: '#b58527',
    activeRowColor: '#8a3d1a',
  },
};

const isAppLanguage = (value: unknown): value is AppLanguage =>
  typeof value === 'string' && supportedAppLanguages.includes(value as AppLanguage);

const isKnownDefaultLabel = (type: OverlayComponentType, label: string): boolean =>
  supportedAppLanguages.some((language) => getOverlayComponentLabel(type, language) === label) ||
  (type === 'golds' && label === 'Golds');

const sanitizeComponents = (value: unknown, language: AppLanguage): OverlayComponent[] => {
  if (!Array.isArray(value)) {
    return defaultOverlayComponents.map((component) => ({
      ...component,
      label: getOverlayComponentLabel(component.type, language),
    }));
  }
  const usedIds = new Set<string>();
  const components: OverlayComponent[] = [];
  value.slice(0, 32).forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return;
    const source = candidate as Partial<OverlayComponent>;
    if (!overlayComponentTypes.includes(source.type as OverlayComponentType)) return;
    const type = source.type as OverlayComponentType;
    const baseId = typeof source.id === 'string' && source.id.trim()
      ? source.id.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
      : `${type}-${index + 1}`;
    let id = baseId || `${type}-${index + 1}`;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);
    const fallbackLabel = getOverlayComponentLabel(type, language);
    const sourceLabel = typeof source.label === 'string' && source.label.trim()
      ? source.label.trim().slice(0, 64)
      : fallbackLabel;
    const label = isKnownDefaultLabel(type, sourceLabel) ? fallbackLabel : sourceLabel;
    components.push({ id, type, label });
  });
  return components;
};

export const sanitizeOverlayTheme = (value: unknown): OverlayTheme => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<OverlayTheme>;
  const language = isAppLanguage(source.language) ? source.language : DEFAULT_APP_LANGUAGE;
  const merged: OverlayTheme = { ...defaultOverlayTheme, ...source, language };
  const clampNumber = (input: number, min: number, max: number, fallback: number): number => {
    const numeric = Number(input);
    return Number.isFinite(numeric) ? Math.min(Math.max(numeric, min), max) : fallback;
  };
  const clampBool = (input: unknown, fallback: boolean): boolean =>
    typeof input === 'boolean' ? input : fallback;
  const clampColor = (input: string, fallback: string): string =>
    typeof input === 'string' && /^#[0-9a-fA-F]{6}$/.test(input) ? input : fallback;

  return {
    fontFamily: typeof merged.fontFamily === 'string' && merged.fontFamily.trim() ? merged.fontFamily : defaultOverlayTheme.fontFamily,
    timeFontFamily: typeof merged.timeFontFamily === 'string' && merged.timeFontFamily.trim() ? merged.timeFontFamily : defaultOverlayTheme.timeFontFamily,
    fontWeight: clampNumber(merged.fontWeight, 100, 900, defaultOverlayTheme.fontWeight),
    timeFontWeight: clampNumber(merged.timeFontWeight, 100, 900, defaultOverlayTheme.timeFontWeight),
    baseFontSize: clampNumber(merged.baseFontSize, 8, 40, defaultOverlayTheme.baseFontSize),
    segmentFontSize: clampNumber(merged.segmentFontSize, 8, 40, defaultOverlayTheme.segmentFontSize),
    timeFontSize: clampNumber(merged.timeFontSize, 16, 160, defaultOverlayTheme.timeFontSize),
    gameFontSize: clampNumber(merged.gameFontSize, 8, 40, defaultOverlayTheme.gameFontSize),
    categoryFontSize: clampNumber(merged.categoryFontSize, 8, 30, defaultOverlayTheme.categoryFontSize),
    footerFontSize: clampNumber(merged.footerFontSize, 8, 30, defaultOverlayTheme.footerFontSize),
    padding: clampNumber(merged.padding, 0, 60, defaultOverlayTheme.padding),
    segmentPadding: clampNumber(merged.segmentPadding, 0, 40, defaultOverlayTheme.segmentPadding),
    segmentGap: clampNumber(merged.segmentGap, 0, 20, defaultOverlayTheme.segmentGap),
    sectionGap: clampNumber(merged.sectionGap, 0, 40, defaultOverlayTheme.sectionGap),
    borderRadius: clampNumber(merged.borderRadius, 0, 40, defaultOverlayTheme.borderRadius),
    backgroundColor: clampColor(merged.backgroundColor, defaultOverlayTheme.backgroundColor),
    backgroundOpacity: clampNumber(merged.backgroundOpacity, 0, 1, defaultOverlayTheme.backgroundOpacity),
    backgroundBlur: clampNumber(merged.backgroundBlur, 0, 40, defaultOverlayTheme.backgroundBlur),
    borderColor: clampColor(merged.borderColor, defaultOverlayTheme.borderColor),
    borderWidth: clampNumber(merged.borderWidth, 0, 8, defaultOverlayTheme.borderWidth),
    textColor: clampColor(merged.textColor, defaultOverlayTheme.textColor),
    mutedColor: clampColor(merged.mutedColor, defaultOverlayTheme.mutedColor),
    accentColor: clampColor(merged.accentColor, defaultOverlayTheme.accentColor),
    aheadColor: clampColor(merged.aheadColor, defaultOverlayTheme.aheadColor),
    behindColor: clampColor(merged.behindColor, defaultOverlayTheme.behindColor),
    goldColor: clampColor(merged.goldColor, defaultOverlayTheme.goldColor),
    completedTimerColor: clampColor(merged.completedTimerColor, defaultOverlayTheme.completedTimerColor),
    activeRowColor: clampColor(merged.activeRowColor, defaultOverlayTheme.activeRowColor),
    timeAlignment: (['left', 'center', 'right'] as const).includes(merged.timeAlignment as TimeAlignment) ? merged.timeAlignment as TimeAlignment : defaultOverlayTheme.timeAlignment,
    timeLetterSpacing: clampNumber(merged.timeLetterSpacing, -10, 10, defaultOverlayTheme.timeLetterSpacing),
    layoutOrientation: (['vertical', 'horizontal'] as const).includes(merged.layoutOrientation as LayoutOrientation) ? merged.layoutOrientation as LayoutOrientation : defaultOverlayTheme.layoutOrientation,
    language,
    components: sanitizeComponents(source.components, language),
    showGame: clampBool(merged.showGame, defaultOverlayTheme.showGame),
    showCategory: clampBool(merged.showCategory, defaultOverlayTheme.showCategory),
    showSegments: clampBool(merged.showSegments, defaultOverlayTheme.showSegments),
    showPhase: clampBool(merged.showPhase, defaultOverlayTheme.showPhase),
    showFooter: clampBool(merged.showFooter, defaultOverlayTheme.showFooter),
    showDeltas: clampBool(merged.showDeltas, defaultOverlayTheme.showDeltas),
    showSegmentTime: clampBool(merged.showSegmentTime, defaultOverlayTheme.showSegmentTime),
    showSegmentTimer: clampBool(merged.showSegmentTimer, defaultOverlayTheme.showSegmentTimer),
    compactTime: clampBool(merged.compactTime, defaultOverlayTheme.compactTime),
    uppercaseCategory: clampBool(merged.uppercaseCategory, defaultOverlayTheme.uppercaseCategory),
  };
};

export const hexToRgba = (hex: string, alpha: number): string => {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return `rgba(0, 0, 0, ${alpha})`;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const clamped = Math.min(Math.max(alpha, 0), 1);
  return `rgba(${r}, ${g}, ${b}, ${clamped})`;
};

const bridge = window.gameTimeSpliter;
const i18n = window.gtsI18n;
const t = (key, params) => i18n.t(key, params);
const overlayErrorKeys = new Map([
  ['Escolha de finalização inválida.', 'error.finishInvalid'],
  ['A run ainda não foi finalizada.', 'error.runNotFinished'],
  ['Esta run ainda não possui um arquivo para sobrescrever. Salve em um novo arquivo.', 'error.noOverwriteFile'],
]);
const localizeOverlayError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const key = overlayErrorKeys.get(message);
  return key ? t(key) : message;
};
const byId = (id) => document.getElementById(id);
const root = byId('root');
const componentStack = byId('components');
const finishActions = byId('finish-actions');
const finishOverwrite = byId('finish-overwrite');
const finishSaveAs = byId('finish-save-as');
const finishDiscard = byId('finish-discard');
const finishStatus = byId('finish-actions-status');

let clickThrough = false;
let pinned = true;
let compactTime = false;
let showDeltas = true;
let showSegmentTimer = false;
let currentTheme = null;
let currentTimer = null;
// Estado da corrida já reduzido pelo main (RaceOverlayState). null = sem corrida ativa.
let currentRace = null;
let lastRenderedSplitIndex = null;
let finishActionBusy = false;
let finishStatusTranslationKey = null;
let dragControlsHideTimer = null;
let appliedDragControlsVisible = null;

const syncDragControlsLayout = () => {
  const visible = root.classList.contains('drag-controls-visible') && !clickThrough;
  if (appliedDragControlsVisible === visible) return;
  appliedDragControlsVisible = visible;
  void bridge.setOverlayDragControlsVisible(visible).catch(() => {
    if (appliedDragControlsVisible === visible) appliedDragControlsVisible = null;
  });
};

const showDragControls = () => {
  if (dragControlsHideTimer !== null) {
    window.clearTimeout(dragControlsHideTimer);
    dragControlsHideTimer = null;
  }
  root.classList.add('drag-controls-visible');
  syncDragControlsLayout();
};

const scheduleDragControlsHide = () => {
  if (dragControlsHideTimer !== null) window.clearTimeout(dragControlsHideTimer);
  dragControlsHideTimer = window.setTimeout(() => {
    root.classList.remove('drag-controls-visible');
    dragControlsHideTimer = null;
    syncDragControlsLayout();
  }, 2_000);
};

root.addEventListener('pointerenter', showDragControls);
root.addEventListener('pointermove', showDragControls);
root.addEventListener('pointerleave', scheduleDragControlsHide);
showDragControls();
scheduleDragControlsHide();

const hexToRgba = (hex, alpha) => {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!match) return `rgba(0, 0, 0, ${alpha})`;
  const value = parseInt(match[1], 16);
  const clamped = Math.min(Math.max(Number(alpha) || 0, 0), 1);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${clamped})`;
};

const decimalSeparator = () => new Intl.NumberFormat(i18n.locale).formatToParts(1.1)
  .find((part) => part.type === 'decimal')?.value || '.';

const formatTime = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const negative = ms < 0;
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1_000);
  const centiseconds = Math.floor((abs % 1_000) / 10);
  const suffix = compactTime ? '' : `${decimalSeparator()}${String(centiseconds).padStart(2, '0')}`;
  const prefix = negative ? '-' : '';
  return hours > 0
    ? `${prefix}${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${suffix}`
    : `${prefix}${minutes}:${String(seconds).padStart(2, '0')}${suffix}`;
};

const formatDelta = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1_000);
  const centiseconds = Math.floor((abs % 1_000) / 10);
  const value = minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}${decimalSeparator()}${String(centiseconds).padStart(2, '0')}`
    : `${seconds}${decimalSeparator()}${String(centiseconds).padStart(2, '0')}`;
  return `${ms < 0 ? '-' : '+'}${value}`;
};

const phaseLabel = (phase) => ['notRunning', 'running', 'paused', 'ended'].includes(phase)
  ? t(`timer.phase.${phase}`)
  : t('timer.phase.unavailable');
const create = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const deltaClass = (value, gold = false) => gold ? 'gold' : value < 0 ? 'ahead' : value > 0 ? 'behind' : '';
const segmentDuration = (segments, index, field) => {
  const current = segments[index]?.[field];
  if (current === null || current === undefined) return null;
  if (index === 0) return current;
  const previous = segments[index - 1]?.[field];
  return previous === null || previous === undefined ? null : current - previous;
};

/**
 * Tempo cumulativo em que o segmento `index` começou.
 *
 * Volta procurando o último split concluído em vez de olhar só `index - 1`, porque um split pulado
 * fica com `splitTimeMs` nulo. Nesse caso o segmento atual engloba os pulados, que é o mesmo que o
 * LiveSplit faz. Sem split concluído antes, o segmento começa no zero da run.
 */
const segmentStartMs = (segments, index) => {
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const splitTime = segments[previous]?.splitTimeMs;
    if (splitTime !== null && splitTime !== undefined) return splitTime;
  }
  return 0;
};

/** Índice do segmento em andamento, ou `null` quando não há run correndo. */
const runningSegmentIndex = (state) => {
  if (!state?.available || state.phase !== 'running' && state.phase !== 'paused') return null;
  const index = state.currentSplitIndex;
  if (index === null || index === undefined) return null;
  return index >= 0 && index < state.segments.length ? index : null;
};

/**
 * Tempo do segmento em andamento, contando do zero.
 *
 * Derivado no renderer porque o protocolo não traz duração de segmento: só tempos cumulativos.
 * Anda em passos de 100 ms, a cadência com que o sidecar publica estado — a mesma do cronômetro
 * principal.
 */
const liveSegmentTimeMs = (state) => {
  const index = runningSegmentIndex(state);
  if (index === null) return null;
  const elapsed = (state.currentTimeMs || 0) - segmentStartMs(state.segments, index);
  return Math.max(0, elapsed);
};

/**
 * Delta ao vivo do split em andamento, contra o PB, assim que o gold daquele segmento é perdido.
 *
 * O valor é o delta **do total**: se a run estava 5 s adiantada, ele parte de -5 s e cresce
 * enquanto o segmento se estende, podendo virar positivo e virar timeloss. Enquanto o segmento
 * ainda cabe no gold não há nada a mostrar, porque o resultado do segmento ainda pode melhorar o
 * tempo acumulado.
 *
 * Devolve `null` quando falta o gold ou o PB daquele split, que é o caso de uma run sem histórico.
 */
const liveTotalDeltaMs = (state, index) => {
  if (runningSegmentIndex(state) !== index) return null;
  const segment = state.segments[index];
  const gold = segment?.bestSegmentTimeMs;
  const personalBest = segment?.personalBestTimeMs;
  if (gold === null || gold === undefined) return null;
  if (personalBest === null || personalBest === undefined) return null;
  const elapsed = liveSegmentTimeMs(state);
  if (elapsed === null || elapsed <= gold) return null;
  return (state.currentTimeMs || 0) - personalBest;
};

const renderTitle = (state) => {
  const section = create('section', 'layout-component component-title');
  section.append(
    create('p', 'game', state?.available ? state.gameName || t('overlay.runFallback') : t('timer.noRun')),
    create('p', 'category', state?.available ? state.categoryName || '' : t('overlay.openRun'))
  );
  return section;
};

const renderSplits = (state) => {
  const section = create('section', 'layout-component component-splits');
  const list = create('ol', 'segments');
  const segments = state?.available ? state.segments : [];
  if (!segments.length) list.append(create('li', 'empty', t('overlay.emptySegments')));
  segments.forEach((segment, index) => {
    const row = create('li', index === state.currentSplitIndex ? 'active' : '');
    const name = create('span', 'name', segment.name);
    const delta = create('span', 'delta');
    const live = showDeltas ? liveTotalDeltaMs(state, index) : null;
    if (live !== null) {
      // Split em andamento que já passou do gold: a célula do delta, que ficaria vazia até o split
      // fechar, passa a mostrar o delta do total correndo.
      delta.textContent = formatDelta(live);
      delta.classList.add('live', deltaClass(live));
    } else if (showDeltas && segment.splitTimeMs !== null && segment.personalBestTimeMs !== null) {
      const value = segment.splitTimeMs - segment.personalBestTimeMs;
      const duration = segmentDuration(segments, index, 'splitTimeMs');
      const isGold = segment.bestSegmentTimeMs !== null && duration !== null && duration <= segment.bestSegmentTimeMs;
      delta.textContent = formatDelta(value);
      delta.classList.add(deltaClass(value, isGold));
    }
    const split = create('span', 'split-time', formatTime(segment.splitTimeMs ?? segment.personalBestTimeMs));
    if (segment.splitTimeMs === null) split.style.opacity = '.7';
    row.append(name, delta, split);
    list.append(row);
  });
  const personalBest = segments.length
    ? segments[segments.length - 1].personalBestTimeMs
    : null;
  const summary = create('div', 'split-pb-summary');
  summary.title = t('timer.pbFinalTitle');
  summary.append(
    create('span', 'split-pb-label', i18n.componentLabel('personalBest')),
    create('strong', 'split-pb-time', formatTime(personalBest))
  );
  section.append(list, summary);
  return section;
};

const renderTimer = (state) => {
  const section = create('section', 'layout-component component-timer');
  const timer = create('span', `timer-value ${state?.phase || ''}`, formatTime(state?.currentTimeMs || 0));
  const phase = create('span', 'phase', phaseLabel(state?.phase));
  section.append(timer, phase);
  if (showSegmentTimer) {
    // Linha própria abaixo do cronômetro principal. Fora de uma run mostra zero, como o principal,
    // em vez de travessão: é um cronômetro, e não uma estatística que possa faltar.
    section.append(create('span', 'segment-timer', formatTime(liveSegmentTimeMs(state) ?? 0)));
  }
  return section;
};

const renderStat = (type, label, value, semanticClass = '') => {
  const section = create('section', `layout-component component-stat component-${type}`);
  const output = create('span', `stat-value ${semanticClass}`, value);
  section.append(create('span', 'stat-label', label), output);
  return section;
};

/**
 * Campo da corrida. Função pura do estado em cache: renderLayout reconstrói o DOM a cada
 * atualização do timer (~10 Hz), então nada de efeito colateral aqui.
 *
 * O delta vem calculado pelo servidor no maior split que os dois jogadores já completaram,
 * ou seja, ele só avança depois que o jogador mais lento cruza a porta.
 */
const renderRaceDelta = (race) => {
  const opponent = race.opponentUsername ? String(race.opponentUsername).slice(0, 16) : '';
  const label = opponent ? `${t('overlay.raceVs')} ${opponent}` : t('overlay.race');
  if (race.attemptInvalidated) {
    return renderStat('raceDelta', label, t('overlay.raceReset'), 'behind');
  }
  return renderStat(
    'raceDelta',
    label,
    formatDelta(race.deltaMs),
    race.deltaMs === null ? '' : deltaClass(race.deltaMs)
  );
};

const renderComponent = (component, state) => {
  const label = i18n.componentLabel(component.type, component.label);
  const segments = state?.available ? state.segments : [];
  const currentIndex = !segments.length
    ? -1
    : state?.phase === 'ended'
      ? segments.length - 1
      : Math.max(0, Math.min(state?.currentSplitIndex ?? 0, segments.length - 1));
  const previousIndex = state?.phase === 'ended' ? segments.length - 1 : currentIndex - 1;
  switch (component.type) {
    case 'title': return renderTitle(state);
    case 'splits': return renderSplits(state);
    case 'timer': return renderTimer(state);
    case 'previousSegment': {
      const actualDuration = segmentDuration(segments, previousIndex, 'splitTimeMs');
      const pbDuration = segmentDuration(segments, previousIndex, 'personalBestTimeMs');
      const delta = actualDuration != null && pbDuration != null ? actualDuration - pbDuration : null;
      return renderStat(
        component.type,
        label,
        delta == null ? formatTime(actualDuration) : formatDelta(delta),
        delta == null ? '' : deltaClass(delta)
      );
    }
    case 'golds': {
      const gold = segments[currentIndex]?.bestSegmentTimeMs;
      return renderStat(
        component.type,
        label,
        formatTime(gold),
        gold == null ? '' : 'gold'
      );
    }
    case 'segmentPersonalBest': {
      const personalBest = segments[currentIndex]?.personalBestSegmentTimeMs;
      return renderStat(component.type, label, formatTime(personalBest));
    }
    case 'sumOfBest': {
      const values = segments.map((segment) => segment.bestSegmentTimeMs);
      const sum = values.length && values.every((value) => value != null) ? values.reduce((total, value) => total + value, 0) : null;
      return renderStat(component.type, label, formatTime(sum));
    }
    case 'personalBest': {
      const pb = segments.length ? segments[segments.length - 1].personalBestTimeMs : null;
      return renderStat(component.type, label, formatTime(pb));
    }
    case 'attempts': return renderStat(component.type, label, i18n.formatNumber(state?.attemptCount || 0));
    case 'money': {
      const money = state?.autosplit?.money;
      return renderStat(
        component.type,
        label,
        money == null ? '—' : `${i18n.formatNumber(money)} ₧`
      );
    }
    case 'chapterKills': {
      const kills = state?.autosplit?.chapterKills;
      return renderStat(component.type, label, kills == null ? '—' : i18n.formatNumber(kills));
    }
    case 'igt': {
      const igtMs = state?.autosplit?.igtMs;
      return renderStat(component.type, label, formatTime(igtMs));
    }
    case 'pauseBuffers': {
      const buffers = state?.autosplit?.pauseBuffers;
      return renderStat(component.type, label, buffers == null ? '—' : i18n.formatNumber(buffers));
    }
    case 'separator': return create('div', 'layout-component component-separator');
    // Só existe se uma versão futura promover o campo a tipo persistido no tema; hoje ele é
    // injetado no fim de renderLayout. Estar aqui mantém a posição escolhida pelo usuário.
    case 'raceDelta': return currentRace ? renderRaceDelta(currentRace) : null;
    default: return null;
  }
};

const renderLayout = () => {
  const scrollPositions = new Map();
  componentStack.querySelectorAll('.component-splits').forEach((section) => {
    const list = section.querySelector('.segments');
    if (list && section.dataset.componentId) scrollPositions.set(section.dataset.componentId, list.scrollTop);
  });
  const nextSplitIndex = currentTimer?.available ? currentTimer.currentSplitIndex : null;
  const activeSplitChanged = nextSplitIndex !== lastRenderedSplitIndex;

  componentStack.replaceChildren();
  const components = currentTheme?.components || [];
  components.forEach((component) => {
    const element = renderComponent(component, currentTimer);
    if (element) {
      element.dataset.componentId = component.id;
      componentStack.append(element);
    }
  });
  // Injetado em runtime e nunca persistido no tema: aparece sozinho ao aceitar uma corrida,
  // abaixo de todos os outros componentes, e desaparece quando ela é encerrada. Isso evita
  // mutar o layout salvo do usuário e não depende do sanitizeComponents do backend conhecer
  // o tipo. O guard respeita a posição escolhida caso o campo já esteja no tema.
  if (currentRace && !components.some((component) => component.type === 'raceDelta')) {
    const raceElement = renderRaceDelta(currentRace);
    raceElement.dataset.componentId = 'race-delta';
    componentStack.append(raceElement);
  }

  if (!componentStack.children.length) componentStack.append(create('p', 'empty-layout', t('overlay.emptyLayout')));
  root.classList.toggle('is-idle', !currentTimer?.available);

  requestAnimationFrame(() => {
    componentStack.querySelectorAll('.component-splits').forEach((section) => {
      const list = section.querySelector('.segments');
      if (!list) return;
      const previousScrollTop = scrollPositions.get(section.dataset.componentId);
      if (!activeSplitChanged && previousScrollTop !== undefined) {
        list.scrollTop = previousScrollTop;
        return;
      }
      const active = list.querySelector('li.active');
      if (!active) return;
      const listRect = list.getBoundingClientRect();
      const rowRect = active.getBoundingClientRect();
      if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top;
      else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
    });
  });
  lastRenderedSplitIndex = nextSplitIndex;
};

const updateClickThroughUi = (value) => {
  clickThrough = Boolean(value);
  root.classList.toggle('is-click-through', clickThrough);
  syncDragControlsLayout();
  const button = byId('toggle-click-through');
  button.textContent = clickThrough ? t('overlay.clicksIgnored') : t('overlay.ignore');
  button.title = clickThrough
    ? t('overlay.restoreClicksTitle')
    : t('overlay.allowThroughTitle');
  button.classList.toggle('active', clickThrough);
};
const applyClickThrough = async (value) => {
  updateClickThroughUi(value);
  await bridge.setOverlayClickThrough(clickThrough);
};
const applyPin = async (value) => {
  pinned = Boolean(value);
  byId('toggle-pin').textContent = pinned ? t('overlay.pin') : t('overlay.free');
  byId('toggle-pin').classList.toggle('active', pinned);
  await bridge.setOverlayAlwaysOnTop(pinned);
};

const applyTheme = (theme) => {
  if (!theme) return;
  currentTheme = theme;
  i18n.setLanguage(theme.language || 'en');
  updateClickThroughUi(clickThrough);
  byId('toggle-pin').textContent = pinned ? t('overlay.pin') : t('overlay.free');
  compactTime = Boolean(theme.compactTime);
  showDeltas = Boolean(theme.showDeltas);
  showSegmentTimer = Boolean(theme.showSegmentTimer);
  const style = document.documentElement.style;
  const set = (name, value) => style.setProperty(name, value);
  set('--font-family', theme.fontFamily); set('--time-font-family', theme.timeFontFamily);
  set('--font-weight', theme.fontWeight); set('--time-font-weight', theme.timeFontWeight);
  set('--base-font-size', `${theme.baseFontSize}px`); set('--segment-font-size', `${theme.segmentFontSize}px`);
  set('--time-font-size', `${theme.timeFontSize}px`); set('--game-font-size', `${theme.gameFontSize}px`);
  set('--category-font-size', `${theme.categoryFontSize}px`); set('--footer-font-size', `${theme.footerFontSize}px`);
  set('--padding', `${theme.padding}px`); set('--segment-padding', `${theme.segmentPadding}px`);
  set('--segment-gap', `${theme.segmentGap}px`); set('--section-gap', `${theme.sectionGap}px`);
  set('--border-radius', `${theme.borderRadius}px`); set('--bg', hexToRgba(theme.backgroundColor, theme.backgroundOpacity));
  set('--bg-blur', `${theme.backgroundBlur}px`); set('--edge', hexToRgba(theme.borderColor, .28));
  set('--border-width', `${theme.borderWidth}px`); set('--text', theme.textColor); set('--muted', theme.mutedColor);
  set('--accent', theme.accentColor); set('--ahead', theme.aheadColor); set('--behind', theme.behindColor);
  set('--gold', theme.goldColor); set('--completed-timer-color', theme.completedTimerColor); set('--active-color', theme.activeRowColor);
  set('--row-active', hexToRgba(theme.activeRowColor, .28)); set('--time-align', theme.timeAlignment);
  set('--time-letter-spacing', `${theme.timeLetterSpacing}px`);
  root.classList.toggle('no-blur', theme.backgroundBlur <= 0);
  root.classList.toggle('hide-game', !theme.showGame); root.classList.toggle('hide-category', !theme.showCategory);
  root.classList.toggle('hide-segments', !theme.showSegments); root.classList.toggle('hide-phase', !theme.showPhase);
  root.classList.toggle('hide-footer', !theme.showFooter); root.classList.toggle('hide-deltas', !theme.showDeltas);
  root.classList.toggle('hide-segment-time', !theme.showSegmentTime); root.classList.toggle('uppercase-category', theme.uppercaseCategory);
  root.classList.remove('time-left', 'time-center', 'time-right', 'orientation-vertical', 'orientation-horizontal');
  root.classList.add(`time-${theme.timeAlignment || 'right'}`, `orientation-${theme.layoutOrientation || 'vertical'}`);
  if (finishStatusTranslationKey) finishStatus.textContent = t(finishStatusTranslationKey);
  renderLayout();
};

const setFinishStatus = (translationKey = null, rawText = '') => {
  finishStatusTranslationKey = translationKey;
  finishStatus.textContent = translationKey ? t(translationKey) : rawText;
};

const updateFinishActions = (visible) => {
  finishActions.hidden = !visible;
  finishActions.setAttribute('aria-hidden', String(!visible));
  finishOverwrite.disabled = finishActionBusy || !currentTimer?.sourcePath;
  finishSaveAs.disabled = finishActionBusy;
  finishDiscard.disabled = finishActionBusy;
};

const applyRaceState = (race) => {
  currentRace = race && typeof race === 'object' ? race : null;
  renderLayout();
};

const renderTimerState = (state) => {
  const previousPhase = currentTimer?.phase;
  currentTimer = state;
  if (state?.phase === 'ended') {
    if (previousPhase !== 'ended') {
      finishActionBusy = false;
      setFinishStatus();
      if (clickThrough) void applyClickThrough(false).catch(() => updateClickThroughUi(true));
    }
    updateFinishActions(true);
  } else {
    finishActionBusy = false;
    setFinishStatus();
    updateFinishActions(false);
  }
  renderLayout();
};

const finishConfirmationKeys = {
  overwrite: 'confirm.finish.overwrite',
  saveAs: 'confirm.finish.saveAs',
  discard: 'confirm.finish.discard',
};

const finishRun = async (action) => {
  if (finishActionBusy || currentTimer?.phase !== 'ended') return;
  if (!window.confirm(t(finishConfirmationKeys[action]))) return;

  finishActionBusy = true;
  setFinishStatus(action === 'discard' ? 'finish.discarding' : 'finish.saving');
  updateFinishActions(true);
  try {
    const state = await bridge.finishTimer({ action });
    if (state) {
      renderTimerState(state);
    } else {
      setFinishStatus('finish.cancelled');
    }
  } catch (error) {
    setFinishStatus(null, localizeOverlayError(error));
  } finally {
    finishActionBusy = false;
    updateFinishActions(currentTimer?.phase === 'ended');
  }
};

finishOverwrite.addEventListener('click', () => void finishRun('overwrite'));
finishSaveAs.addEventListener('click', () => void finishRun('saveAs'));
finishDiscard.addEventListener('click', () => void finishRun('discard'));

byId('toggle-pin').addEventListener('click', async () => {
  const previous = pinned;
  try { await applyPin(!previous); } catch {
    pinned = previous;
    byId('toggle-pin').textContent = pinned ? t('overlay.pin') : t('overlay.free');
    byId('toggle-pin').classList.toggle('active', pinned);
  }
});
byId('toggle-click-through').addEventListener('click', async () => {
  const previous = clickThrough;
  if (!previous && !window.confirm(t('confirm.clickThrough'))) return;
  try { await applyClickThrough(!previous); } catch { updateClickThroughUi(previous); }
});
byId('close-overlay').addEventListener('click', () => void bridge.closeOverlay());
bridge.onEvent((event) => {
  if (event.type === 'timer-state' && event.data) renderTimerState(event.data);
  else if (event.type === 'race-state') applyRaceState(event.data);
  else if (event.type === 'state' && event.data?.timer) {
    // Atualiza a corrida antes do timer para o renderLayout de renderTimerState já
    // desenhar o campo com o estado novo, em vez de renderizar duas vezes.
    if ('race' in event.data) currentRace = event.data.race ?? null;
    renderTimerState(event.data.timer);
    if (typeof event.data.overlayClickThrough === 'boolean') updateClickThroughUi(event.data.overlayClickThrough);
  } else if (event.type === 'overlay-theme' && event.data) applyTheme(event.data);
  else if (event.type === 'overlay-click-through') updateClickThroughUi(Boolean(event.data?.enabled));
});
i18n.applyToDocument();
(async () => {
  try {
    applyTheme(await bridge.getOverlayTheme());
    const state = await bridge.getState();
    // A overlay pode ser aberta no meio de uma corrida, então o estado vem no boot também.
    currentRace = state.race ?? null;
    renderTimerState(state.timer);
  } catch { renderTimerState(null); }
  try { await applyPin(true); } catch { /* A janela continua utilizável sem always-on-top. */ }
  try { await applyClickThrough(false); } catch { /* O modo interativo local permanece ativo. */ }
})();

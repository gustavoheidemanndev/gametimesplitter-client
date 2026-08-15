export type TimerPhase = 'notRunning' | 'running' | 'paused' | 'ended';

export interface TimerSegmentState {
  name: string;
  splitTimeMs: number | null;
  personalBestTimeMs: number | null;
  personalBestSegmentTimeMs: number | null;
  bestSegmentTimeMs: number | null;
  /** Cumulative Best Split Times comparison: best pace ever at this split, not necessarily PB. */
  bestSplitTimeMs: number | null;
}

export interface AutosplitConfig {
  enabled: boolean;
  profile: 're4UhdSteam';
  version: 'auto' | '1.1.0' | '1.0.6';
  autoStart: boolean;
  /**
   * Marcado: o timer só inicia num jogo novo, entrando na primeira sala a partir do título.
   * Desmarcado: inicia ao entrar em qualquer sala do jogo, o que cobre abrir um save.
   */
  startOnlyOnNewGame: boolean;
  splitOnDoors: boolean;
  /** Split no fim de cada capítulo. Evento próprio do jogo, independente de porta. */
  splitOnChapters: boolean;
  /**
   * Capítulos cujo fim não gera split próprio, porque a porta logo depois é o limite do segmento.
   *
   * O índice é o valor que o contador do jogo assume ao fechar o capítulo: 1 = fim do 1-1,
   * 2 = fim do 1-2, 3 = fim do 1-3, 4 = fim do 2-1, e assim por diante. Depende da rota e de
   * quantos segmentos o `.lss` tem no trecho, então não é inferível da memória do jogo.
   */
  chapterEndsWithoutSplit: number[];
  /**
   * Voltas que **não** fecham segmento, por serem reatravessia do mesmo limite em vez de caminho.
   * Cada item é a transição de volta, na ordem `[sala de origem, sala de destino]`.
   *
   * Volta splita por padrão porque é o caso comum: voltar do Mendez, da saída do capítulo 7 e de
   * outros sete trios é caminho obrigatório da rota. Voltar do sword room é estratégia do jogador.
   * O tempo na sala não distingue os dois, então não é inferível da memória do jogo.
   */
  returnDoorsWithoutSplit: [number, number][];
  /**
   * Portas que nunca fecham segmento, porque o limite ali é o fim de capítulo e não a porta.
   * Cada item é `[sala de origem, sala de destino]`.
   *
   * Não é inferível: a ordem entre a porta e o avanço de capítulo varia por capítulo, e quando a
   * porta vem primeiro não há sinal de que um capítulo está chegando. Mesmo mecanismo da
   * `BlackListedDoors` do autosplitter da comunidade.
   */
  doorsWithoutSplit: [number, number][];
  removeLoads: boolean;
  autoReset: boolean;
}

export interface AutosplitState extends AutosplitConfig {
  status: 'disabled' | 'waitingForGame' | 'attached' | 'unsupportedVersion' | 'error';
  message: string;
  processName: string;
  processId: number | null;
  detectedVersion: string | null;
  currentRoom: number | null;
  loading: boolean;
  money: number | null;
  chapterKills: number | null;
  igtMs: number | null;
  pauseBuffers: number | null;
  doorLoadsTimeMs: number | null;
}

export const DEFAULT_AUTOSPLIT_CONFIG: AutosplitConfig = {
  enabled: true,
  profile: 're4UhdSteam',
  version: 'auto',
  autoStart: true,
  // Padrão preserva o comportamento atual: só jogo novo.
  startOnlyOnNewGame: true,
  splitOnDoors: true,
  splitOnChapters: true,
  // Vazia: todo fim de capítulo fecha segmento, como no autosplitter oficial da comunidade. Onde há
  // porta colada no fim do capítulo, quem fica silenciado é a porta, em doorsWithoutSplit.
  chapterEndsWithoutSplit: [],
  // Vazia: o autosplitter oficial não tem o conceito de "volta". Nele a volta é um par distinto da
  // ida, então splita a menos que esteja declarada — e a única que não deve fechar segmento, a do
  // sword room, está na lista incondicional abaixo, onde resiste a um load de save.
  returnDoorsWithoutSplit: [],
  // Espelho da unsplittedDoors do jogo principal do autosplitter oficial, par a par. Precisa ser
  // declarada porque a ordem dos eventos varia: nos capítulos 3-2 e 3-3 o contador de capítulo sobe
  // primeiro, no 3-4 a porta vem primeiro — e aí nada indica que um capítulo está chegando.
  //   [262, 260] fim do 1-1.            [267, 283] fim do 1-3.
  //   [527, 518] fim do 3-3.            [525, 518] fim do 3-4.
  //   [545, 555] fim do 4-1, depois do Verdugo, com porta dos dois lados do avanço.
  //   [555, 544] Prophet's Room (cutscene) para a área antes da mina.
  //   [541, 549] fim do 4-2.            [549, 550] fim do 4-3.
  //   [554, 768] fim do 4-4: castelo (0x2xx) para ilha (0x300), também troca de stage.
  //   [789, 790] fim do 5-2.            [796, 800] fim do 5-3.
  //   [536, 533] Gatekeeper Hallway para Lord's Room; o limite é a cutscene (533 -> 553) depois.
  //   [554, 552] Pier para Tower Summit.
  //   [519, 514] Barracks para Castle Wall, a volta do sword room: você volta por estratégia, não
  //              porque a rota obriga. A ida 514 -> 519 splita normalmente.
  //   [790, 778] e [778, 790] ida e volta na sala 778 depois do fim do 5-2: nenhuma fecha segmento,
  //              e como o bloqueio é direcional os dois sentidos entram.
  //   [818, 817] Steel Tower para Before the Steel Tower, atravessada a caminho da 819.
  // O par [288, 256] da lista oficial não entra: 288 é a sentinela de sistema, que nunca vira sala
  // de origem, então esse limite é tratado como início de run e não como porta.
  // Fora dos pares listados, o sentido inverso de uma porta bloqueada splita normalmente.
  doorsWithoutSplit: [
    [262, 260], [267, 283], [527, 518], [525, 518], [545, 555], [555, 544], [541, 549],
    [549, 550], [554, 768], [789, 790], [796, 800], [536, 533], [554, 552], [519, 514],
    [790, 778], [778, 790], [818, 817],
  ],
  removeLoads: true,
  autoReset: true,
};

export interface TimerState {
  available: boolean;
  phase: TimerPhase;
  currentTimeMs: number;
  gameTimeMs: number | null;
  currentSplitIndex: number | null;
  currentSegmentName: string | null;
  gameName: string;
  categoryName: string;
  attemptCount: number;
  comparison: string;
  sourcePath: string | null;
  segments: TimerSegmentState[];
  autosplit: AutosplitState;
}

export interface ResetTimerRequest {
  updateSplits?: boolean;
}

export interface FinishTimerRequest {
  action: 'overwrite' | 'saveAs' | 'discard';
}

export type TimerCommand =
  | 'ping'
  | 'load'
  | 'create'
  | 'start'
  | 'split'
  | 'pause'
  | 'reset'
  | 'undo'
  | 'skip'
  | 'save'
  | 'finish'
  | 'autosplitConfigure'
  | 'state'
  | 'shutdown';

export interface SidecarRequest<T = unknown> {
  id: number;
  command: TimerCommand;
  payload?: T;
}

export interface SidecarResponse<T = unknown> {
  id: number;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface SidecarEvent<T = unknown> {
  event: 'ready' | 'state' | 'log';
  data: T;
}

export interface TimerCommandResult {
  success: boolean;
  state?: TimerState;
  message?: string;
}

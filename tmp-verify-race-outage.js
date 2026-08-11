'use strict';
/* Verificação temporária: snapshot de splits sobrevive a uma queda da API e é entregue na volta. */
const { RaceSync } = require('./dist/main/services/race-sync');
const { ApiError } = require('./dist/main/services/api-client');

const results = [];
const check = (name, passed, detail) => results.push({ name, passed, detail });

let online = true;
let raceId = 'race-A';
let raceStatus = 'running';
let rejectNextWith = null;
const accepted = [];

const raceState = () => ({
  id: raceId,
  name: 'Sala',
  status: raceStatus,
  revision: 7,
  game: { id: 'g1', name: 'Resident Evil 4', category: 'Any%' },
  splitCount: 3,
  configSplits: ['A', 'B', 'C'],
  maxParticipants: 2,
  me: {
    participantId: 'p1', userId: 'u1', username: 'me', status: 'running',
    clientConnected: true, clientSegmentMismatch: false, isReady: true,
    completedSplits: 0, finalTime: null,
  },
  opponent: {
    participantId: 'p2', userId: 'u2', username: 'rival', status: 'running',
    clientConnected: true, clientSegmentMismatch: false, isReady: true,
    completedSplits: 0, finalTime: null,
  },
  commonSplitOrder: 0,
  deltaMs: null,
  winnerId: null,
  isWinner: null,
  canClaimVictory: false,
  armedAt: new Date(Date.now() - 600_000).toISOString(),
  startedAt: new Date(Date.now() - 600_000).toISOString(),
  finishedAt: null,
  serverTime: new Date().toISOString(),
});

const offline = () => new ApiError('Não foi possível conectar ao servidor.', 0);

const api = {
  getSession: () => ({ user: { id: 'u1', username: 'me' }, accessToken: 'a', refreshToken: 'r' }),
  getActiveRace: async () => { if (!online) throw offline(); return raceState(); },
  getRace: async () => { if (!online) throw offline(); return raceState(); },
  raceClientCheck: async () => { if (!online) throw offline(); return raceState(); },
  reportRaceSplits: async (id, payload) => {
    if (!online) throw offline();
    if (rejectNextWith) { const error = rejectNextWith; rejectNextWith = null; throw error; }
    accepted.push({ raceId: id, ...JSON.parse(JSON.stringify(payload)) });
    return raceState();
  },
};

const timer = (phase, splitCount, attemptCount = 1) => ({
  available: true,
  phase,
  currentTimeMs: splitCount * 60_000,
  gameTimeMs: null,
  currentSplitIndex: splitCount,
  currentSegmentName: 'X',
  gameName: 'Resident Evil 4',
  categoryName: 'Any%',
  attemptCount,
  comparison: 'Personal Best',
  sourcePath: 'C:/run.lss',
  segments: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
  autosplit: { enabled: false, profile: null, attached: false },
});

const splits = (count) => Array.from({ length: count }, (_, index) => ({
  name: `S${index + 1}`,
  order: index + 1,
  splitTime: 60_000,
  cumulativeTime: (index + 1) * 60_000,
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

let overlayState = null;
const sync = new RaceSync(api, {
  onRaceState: (state) => { overlayState = state; },
  onStatus: () => {},
  getTimerState: () => timer('running', 1),
});

(async () => {
  try {
    sync.handleSessionChange(true);
    await sync.refresh();
    check('corrida ativa detectada', overlayState?.raceId === 'race-A', `overlay=${JSON.stringify(overlayState?.raceId)}`);

    // 1) Split normal com a API no ar.
    sync.handleTimerState(timer('notRunning', 0), timer('running', 1), splits(1));
    await settle();
    check(
      'split entregue com a API no ar',
      accepted.length === 1 && accepted[0].splits.length === 1,
      `aceitos=${accepted.length}`
    );

    // 2) API cai e o jogador termina a run: é o snapshot final, sem evento de timer depois.
    online = false;
    const before = accepted.length;
    sync.handleTimerState(timer('running', 2), timer('ended', 3), splits(3));
    await new Promise((resolve) => setTimeout(resolve, 14_500)); // 1s+3s+9s de retry
    check(
      'snapshot final nao foi aceito durante a queda',
      accepted.length === before,
      `aceitos=${accepted.length}`
    );

    // 3) API volta: o poll precisa entregar o snapshot pendente sozinho.
    online = true;
    await sync.refresh();
    await settle();
    const last = accepted[accepted.length - 1];
    check(
      'snapshot final entregue quando a API voltou',
      accepted.length === before + 1 && last.phase === 'ended' && last.splits.length === 3,
      `aceitos=${accepted.length} phase=${last?.phase} splits=${last?.splits.length}`
    );
    check(
      'revisao do snapshot final e maior que a do anterior',
      last.revision > accepted[0].revision,
      `revisoes=${accepted.map((item) => item.revision).join(',')}`
    );
    check(
      'reenvio nao duplicou o snapshot',
      accepted.filter((item) => item.phase === 'ended').length === 1,
      `ended=${accepted.filter((item) => item.phase === 'ended').length}`
    );

    // 4) Um 409 numa corrida nao pode travar o reporte da corrida seguinte.
    sync.handleSessionChange(true);
    await sync.refresh();
    rejectNextWith = new ApiError('O timer foi resetado durante a corrida.', 409);
    sync.handleTimerState(timer('notRunning', 0), timer('running', 1, 2), splits(1));
    await settle();
    check(
      'corrida marcada como invalidada apos 409',
      overlayState?.attemptInvalidated === true,
      `attemptInvalidated=${overlayState?.attemptInvalidated}`
    );

    raceId = 'race-B';
    await sync.refresh();
    await settle();
    check(
      'corrida nova nao herda a invalidacao',
      overlayState?.raceId === 'race-B' && overlayState?.attemptInvalidated === false,
      `raceId=${overlayState?.raceId} attemptInvalidated=${overlayState?.attemptInvalidated}`
    );

    const countBefore = accepted.length;
    sync.handleTimerState(timer('notRunning', 0), timer('running', 1, 3), splits(1));
    await settle();
    check(
      'split da corrida nova e reportado',
      accepted.length === countBefore + 1 && accepted[accepted.length - 1].raceId === 'race-B',
      `aceitos=${accepted.length} ultimo=${accepted[accepted.length - 1]?.raceId}`
    );
  } catch (error) {
    check('execucao sem excecao', false, error && error.stack ? error.stack : String(error));
  }

  sync.stop();
  results.forEach((item) => console.log(`${item.passed ? 'PASS' : 'FAIL'} - ${item.name} :: ${item.detail}`));
  const failed = results.filter((item) => !item.passed).length;
  console.log(`\n${results.length - failed}/${results.length} verificacoes passaram.`);
  process.exit(failed === 0 ? 0 : 1);
})();

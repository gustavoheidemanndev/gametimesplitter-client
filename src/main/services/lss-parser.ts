import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { ParsedLss, RunSplitPayload, RunStatus } from '../../shared/types';

const TIME_PATTERN = /^(-)?(?:(\d+):)?([0-5]?\d):([0-5]?\d)(?:[.,](\d{1,9}))?$/;

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const stringValue = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object' && '#text' in value) {
    return stringValue((value as { '#text': unknown })['#text']);
  }
  return '';
};

export const parseTimeToMilliseconds = (value: unknown): number | null => {
  const normalized = stringValue(value);
  if (!normalized) return null;
  const match = normalized.match(TIME_PATTERN);
  if (!match) return null;

  const [, negative, hoursValue, minutesValue, secondsValue, fractionValue = ''] = match;
  const milliseconds = Number(fractionValue.padEnd(3, '0').slice(0, 3));
  const total = ((Number(hoursValue || 0) * 60 + Number(minutesValue)) * 60 + Number(secondsValue)) * 1000 + milliseconds;
  return negative ? -total : total;
};

const parseLiveSplitDate = (value: unknown): Date | null => {
  const raw = stringValue(value);
  if (!raw) return null;
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) return null;
  const [, month, day, year, hour, minute, second, fraction = ''] = match;
  const parsed = new Date(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
    Number(fraction.padEnd(3, '0').slice(0, 3))
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const realTime = (container: unknown): number | null => {
  if (!container || typeof container !== 'object') return null;
  return parseTimeToMilliseconds((container as Record<string, unknown>).RealTime);
};

const createClientRunId = (identity: object): string =>
  createHash('sha256').update(JSON.stringify(identity)).digest('hex');

export const parseLssFile = async (filePath: string): Promise<ParsedLss> => {
  if (path.extname(filePath).toLocaleLowerCase() !== '.lss') {
    throw new Error('Selecione um arquivo de splits do LiveSplit com extensão .lss.');
  }

  const [xml, fileStats] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)]);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error('O arquivo .lss contém XML inválido ou está sendo gravado pelo LiveSplit.');
  }

  const run = parsed.Run as Record<string, unknown> | undefined;
  if (!run) {
    if (parsed.Layout) throw new Error('O arquivo selecionado é um layout .lsl, não uma run .lss.');
    throw new Error('Formato incompatível: a raiz XML <Run> não foi encontrada.');
  }

  const metadata = (run.Metadata || {}) as Record<string, unknown>;
  const sourceRun = (metadata.Run || {}) as Record<string, unknown>;
  const sourceRunId = stringValue(sourceRun.id);
  const gameName = stringValue(run.GameName);
  const categoryName = stringValue(run.CategoryName);
  const platform = stringValue(metadata.Platform);
  const segmentNodes = asArray(((run.Segments || {}) as Record<string, unknown>).Segment as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const segmentNames = segmentNodes.map((segment, index) => stringValue(segment.Name) || `Segmento ${index + 1}`);
  const attemptNodes = asArray(((run.AttemptHistory || {}) as Record<string, unknown>).Attempt as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const warnings: string[] = [];

  if (!gameName) warnings.push('O .lss não informa o nome do jogo.');
  if (!categoryName) warnings.push('O .lss não informa a categoria.');
  if (segmentNames.length === 0) warnings.push('O .lss não possui segmentos.');
  if (attemptNodes.length === 0) warnings.push('Nenhuma tentativa finalizada foi encontrada em <AttemptHistory>.');

  const attempts = attemptNodes.flatMap((attempt, attemptIndex) => {
    const attemptId = stringValue(attempt.id) || String(attemptIndex + 1);
    const completedTime = realTime(attempt);
    let cumulativeTime = 0;
    const splitTimes: RunSplitPayload[] = [];

    segmentNodes.forEach((segment, segmentIndex) => {
      const history = (segment.SegmentHistory || {}) as Record<string, unknown>;
      const historyEntries = asArray(history.Time as Record<string, unknown> | Record<string, unknown>[] | undefined);
      const matchingTime = historyEntries.find((entry) => stringValue(entry.id) === attemptId);
      const splitTime = realTime(matchingTime);
      if (splitTime === null || splitTime < 0) return;
      cumulativeTime += splitTime;
      splitTimes.push({ name: segmentNames[segmentIndex], order: segmentIndex + 1, splitTime, cumulativeTime });
    });

    const startedValue = stringValue(attempt.started);
    const endedValue = stringValue(attempt.ended);
    const endedAt = parseLiveSplitDate(endedValue);
    if (!endedAt && completedTime === null && splitTimes.length === 0) return [];

    const totalTime = completedTime ?? cumulativeTime;
    if (totalTime < 0) return [];
    const status: RunStatus = completedTime === null ? 'reset' : 'completed';
    const fallbackEnd = endedAt || fileStats.mtime;
    const startedAt = parseLiveSplitDate(startedValue) || new Date(fallbackEnd.getTime() - totalTime);
    const clientRunId = createClientRunId({
      sourceRunId,
      gameName,
      categoryName,
      platform,
      segmentNames,
      attemptId,
      started: startedValue,
      ended: endedValue,
      totalTime,
      splitTimes,
    });

    return [{
      clientRunId,
      configName: `LiveSplit - ${categoryName || path.basename(filePath, '.lss')}`.slice(0, 100),
      configSplits: segmentNames,
      totalTime,
      status,
      startedAt: startedAt.toISOString(),
      completedAt: fallbackEnd.toISOString(),
      splitTimes,
    }];
  });

  return { gameName, categoryName, platform, segmentNames, attempts, warnings };
};

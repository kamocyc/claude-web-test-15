/**
 * `npm run seed` — build the 東急大井町線 sample project, print a summary and
 * run the validator. Exits non-zero if the validator reports any error, so the
 * seed can be wired into CI as a gate the moment the rules land.
 */

import { formatTime } from '@/domain/time';
import { entityList } from '@/domain/units';
import { runValidation } from '@/validation/run';
import { buildOimachiProject, lastBuildReport } from './index';
import { projectDigest } from './digest';

function main(): void {
  const startedAt = performance.now();
  const doc = buildOimachiProject();
  const elapsed = performance.now() - startedAt;
  const digest = projectDigest(doc);
  const report = lastBuildReport();

  const lines: string[] = [];
  lines.push('=== 東急大井町線 平日ダイヤ ===');
  lines.push(`生成時間            ${elapsed.toFixed(0)} ms`);
  lines.push(`駅 / 番線 / 線路区間  ${digest.stations} / ${digest.stationTracks} / ${digest.links}`);
  lines.push(
    `列車                ${digest.trains} (営業 ${digest.serviceTrains} / 回送 ${digest.deadheadTrains})`,
  );
  lines.push(`  下り / 上り        ${digest.trainsByDirection.down} / ${digest.trainsByDirection.up}`);
  for (const [name, count] of Object.entries(digest.trainsByType)) {
    lines.push(`  ${name.padEnd(12, '　')} ${count}`);
  }
  lines.push(`待避停車            ${digest.overtakenStops}`);
  lines.push(`緩急接続            ${digest.connectionStops}`);
  lines.push(`運用                ${digest.duties} (${JSON.stringify(digest.dutiesByCars)})`);
  lines.push(`編成                ${digest.formations} (${JSON.stringify(digest.formationsByCars)})`);
  lines.push(`充当                ${digest.assignments}`);
  lines.push(`検査履歴            ${digest.inspectionRecords}`);
  lines.push(`総走行キロ          ${digest.totalKm} km`);
  lines.push(`同時運用最大        ${digest.peakConcurrentDuties}`);
  lines.push(
    `乗務員行路          ${digest.crewDuties} (${JSON.stringify(digest.crewDutiesByRole)})`,
  );
  lines.push(`  実乗務 計         ${digest.crewWorkHours}時間`);
  lines.push(`  行の内訳          ${JSON.stringify(digest.crewLegsByKind)}`);
  lines.push(`同時乗務最大        ${digest.peakConcurrentCrewDuties}`);

  if (report !== undefined) {
    lines.push('');
    lines.push('--- 時間帯別 ---');
    for (const band of report.perBand) {
      lines.push(
        `  ${band.name.padEnd(6, '　')} ${String(band.trains).padStart(4)}本  ` +
          `下り ${String(band.down).padStart(3)} / 上り ${String(band.up).padStart(3)}  ` +
          `片道 ${band.tph} 本/時`,
      );
    }
    lines.push('');
    lines.push('--- 緩急接続ソルバ ---');
    lines.push(`  収束パス数        ${report.solverPasses}`);
    lines.push(`  解決した待避      ${report.resolvedOvertakes}`);
    lines.push(`  帯端で不成立      ${report.skippedOvertakesAtBandEdge}`);
    lines.push(`  最大待避時分      ${Math.round(report.maxOvertakeWaitSec / 60)}分`);
    lines.push(`  既定番線からの変更 ${report.trackFallbacks}`);
    lines.push(`  回送の筋ずらし最大 ${Math.round(report.maxDepotShiftSec / 60)}分`);
    lines.push(
      `  車庫留置最大      ${report.depotPeakStabled}${report.depotCapacityExceeded ? ' ** 収容能力超過 **' : ''}`,
    );
  }

  const firstTrain = entityList(doc.trains)
    .map((t) => t.stops[0]?.dep ?? t.stops[0]?.arr ?? Number.POSITIVE_INFINITY)
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const lastTrain = entityList(doc.trains)
    .map((t) => {
      const s = t.stops[t.stops.length - 1];
      return s?.arr ?? s?.dep ?? Number.NEGATIVE_INFINITY;
    })
    .reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
  lines.push('');
  lines.push(`運転時間帯          ${formatTime(firstTrain)} 〜 ${formatTime(lastTrain)}`);

  const result = runValidation(doc);
  lines.push('');
  lines.push(
    `検証                エラー ${result.errorCount} / 警告 ${result.warningCount} / 情報 ${result.infoCount}`,
  );
  for (const issue of result.issues.filter((i) => i.severity === 'error').slice(0, 20)) {
    lines.push(`  [error] ${issue.ruleId} ${issue.title} — ${issue.detail}`);
  }

  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));

  if (result.errorCount > 0) process.exitCode = 1;
}

main();

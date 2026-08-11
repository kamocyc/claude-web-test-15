import { ROUTES, TID, type RouteName } from '@e2e/testids';

import { useUiStore } from '@/store/uiStore';

import styles from './Shell.module.css';

export const ROUTE_LABEL: Record<RouteName, string> = {
  [ROUTES.line]: '線区ビュー',
  [ROUTES.diagram]: '運行図表',
  [ROUTES.timetable]: '時刻表',
  [ROUTES.duties]: '運用',
  [ROUTES.crew]: '乗務員',
  [ROUTES.formations]: '編成',
  [ROUTES.stations]: '駅・線路',
  [ROUTES.types]: '種別・パターン',
  [ROUTES.inspections]: '検査',
  [ROUTES.settings]: '設定',
};

const ORDER: RouteName[] = [
  ROUTES.timetable,
  ROUTES.diagram,
  ROUTES.line,
  ROUTES.duties,
  ROUTES.crew,
  ROUTES.formations,
  ROUTES.stations,
  ROUTES.types,
  ROUTES.inspections,
  ROUTES.settings,
];

export function LeftNav() {
  const route = useUiStore((s) => s.route);
  const setRoute = useUiStore((s) => s.setRoute);

  return (
    <nav className={styles.nav} aria-label="画面">
      {ORDER.map((name) => (
        <button
          key={name}
          type="button"
          data-testid={TID.navLink(name)}
          aria-current={route === name ? 'page' : undefined}
          className={`${styles.navLink} ${route === name ? styles.navLinkActive : ''}`}
          onClick={() => setRoute(name)}
        >
          {ROUTE_LABEL[name]}
        </button>
      ))}
    </nav>
  );
}

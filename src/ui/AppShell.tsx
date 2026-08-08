/**
 * The application shell: layout plus every cross-cutting effect.
 *
 * All of the wiring that must exist exactly once — the animation frame, the
 * debounced validator, autosave, the Playwright hooks — is installed here
 * rather than inside screens, so switching screens can never restart a timer or
 * leave two clocks running.
 */

import { useEffect, useRef, useState } from 'react';
import { ROUTES, TID } from '@e2e/testids';

import { snapshotAt } from '@/engine';
import { getIndex, useProjectStore } from '@/store/projectStore';
import {
  onAutosaveStateChange,
  restoreAutosave,
  scheduleAutosave,
  type AutosaveState,
} from '@/store/persistence';
import { clockDriver, installClockLoop, useClockStore } from '@/store/clockStore';
import { scheduleValidation } from '@/store/validationStore';
import { useUiStore } from '@/store/uiStore';
import { IS_E2E, installSimHooks } from '@/testMode';

import { Inspector } from './shell/Inspector';
import { LeftNav } from './shell/LeftNav';
import { ProblemPanel } from './shell/ProblemPanel';
import { StatusBar } from './shell/StatusBar';
import { TopBar } from './shell/TopBar';

import { DiagramScreen } from './screens/DiagramScreen';
import { DutiesScreen } from './screens/DutiesScreen';
import { FormationsScreen } from './screens/FormationsScreen';
import { InspectionsScreen } from './screens/InspectionsScreen';
import { LineScreen } from './screens/LineScreen';
import { StationsScreen } from './screens/StationsScreen';
import { TimetableScreen } from './screens/TimetableScreen';
import { TypesScreen } from './screens/TypesScreen';

import styles from './shell/Shell.module.css';

export function AppShell() {
  const route = useUiStore((s) => s.route);
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);
  const [autosave, setAutosave] = useState<AutosaveState>('idle');
  const rootRef = useRef<HTMLDivElement | null>(null);

  // -- body class ----------------------------------------------------------
  useEffect(() => {
    if (!IS_E2E || typeof document === 'undefined') return undefined;
    document.body.classList.add('e2e');
    return () => document.body.classList.remove('e2e');
  }, []);

  // -- the single animation frame -----------------------------------------
  useEffect(() => installClockLoop(), []);

  // -- keep the clock inside the project's service day ---------------------
  useEffect(() => {
    const apply = (from: number, to: number): void => {
      const clock = useClockStore.getState();
      if (clock.from !== from || clock.to !== to) clock.setRange(from, to);
    };
    const settings = useProjectStore.getState().doc.settings;
    apply(settings.serviceDayStartSec, settings.serviceDayEndSec);
    return useProjectStore.subscribe((s) => {
      apply(s.doc.settings.serviceDayStartSec, s.doc.settings.serviceDayEndSec);
    });
  }, []);

  // -- validation and autosave, both debounced off the revision ------------
  useEffect(() => {
    const getDoc = (): ReturnType<typeof useProjectStore.getState>['doc'] =>
      useProjectStore.getState().doc;
    let lastRevision = useProjectStore.getState().revision;
    scheduleValidation(getDoc);
    const unsubscribe = useProjectStore.subscribe((s) => {
      if (s.revision === lastRevision) return;
      lastRevision = s.revision;
      scheduleValidation(getDoc);
      scheduleAutosave(getDoc, () => useProjectStore.getState().markSaved());
    });
    const unwatch = onAutosaveStateChange(setAutosave);
    return () => {
      unsubscribe();
      unwatch();
    };
  }, []);

  // -- autosave restore, then declare readiness ----------------------------
  useEffect(() => {
    let cancelled = false;
    void restoreAutosave().then((doc) => {
      if (cancelled) return;
      if (doc !== undefined) useProjectStore.getState().hydrate(doc);
      getIndex();
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // -- Playwright hooks ----------------------------------------------------
  useEffect(() => {
    installSimHooks({
      setTime: (sec) => clockDriver.seek(sec),
      step: (sec) => clockDriver.nudge(sec),
      setSpeed: (n) => clockDriver.setSpeed(n),
      play: () => clockDriver.play(),
      pause: () => clockDriver.pause(),
      getTime: () => clockDriver.getState().tSec,
      isReady: () => document.documentElement.getAttribute('data-sim-ready') === '1',
      snapshotDigest: () => {
        const t = clockDriver.getState().tSec;
        const snapshot = snapshotAt(getIndex(), t);
        return {
          t,
          active: snapshot.trains.length,
          trains: snapshot.trains.map((tr) => ({
            id: tr.trainId,
            number: tr.number,
            phase: tr.phase.phase,
            km: tr.km,
          })),
        };
      },
    });
  }, []);

  // -- mirror the state attributes onto the document root ------------------
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-sim-ready', ready ? '1' : '0');
  }, [ready]);

  return (
    <div
      className={styles.app}
      data-testid={TID.app}
      ref={rootRef}
      data-sim-ready={ready ? '1' : '0'}
      data-autosave-state={autosave}
    >
      <TopBar onMessage={setMessage} />
      <div className={styles.middle}>
        <LeftNav />
        <div className={styles.mainColumn}>
          <main className={styles.main}>
            <Screen route={route} />
          </main>
          <ProblemPanel />
        </div>
        <Inspector />
      </div>
      <StatusBar message={message} />
    </div>
  );
}

function Screen({ route }: { route: string }) {
  switch (route) {
    case ROUTES.line:
      return <LineScreen />;
    case ROUTES.diagram:
      return <DiagramScreen />;
    case ROUTES.duties:
      return <DutiesScreen />;
    case ROUTES.formations:
      return <FormationsScreen />;
    case ROUTES.stations:
      return <StationsScreen />;
    case ROUTES.types:
      return <TypesScreen />;
    case ROUTES.inspections:
      return <InspectionsScreen />;
    case ROUTES.timetable:
    default:
      return <TimetableScreen />;
  }
}

import { useEffect, useState } from 'react';
import {
  GravityAccordionItem,
  GravityCallout,
  GravityList,
  GravityButton,
  GravityPanel,
  GravityText,
} from '@gravity/web-components-react';

type Role = 'old' | 'new' | null;
type LeadingType = 'image' | 'icon' | 'avatar' | 'flag';

interface Candidate {
  key: string;
  name: string;
  count: number;
  exampleNodeId: string;
  pageName: string;
  role: Role;
}

interface Resolution {
  oldMainKey: string;
  oldMainName: string;
  newMainKey: string;
  newMainName: string;
  oldLeadingSetKey: string | null;
  newLeadingTypeKeys: Partial<Record<LeadingType, { key: string; name: string }>>;
  newLeadingSetKey: string | null;
  newActionKey: { key: string; name: string } | null;
  diagnostics: string[];
}

interface Summary {
  scope: string;
  source: number;
  migrated: number;
  skipped: number;
  failed: number;
  manualReview: number;
}

interface ExceptionRow {
  id: string;
  replacementId?: string;
  status: string;
  reason: string;
}

type MigrateState =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string };


const post = (msg: unknown) => parent.postMessage({ pluginMessage: msg }, '*');

function CountBadge({ count, scanned }: { count: number; scanned: boolean }) {
  if (!scanned) {
    return (
      <GravityText size="xx-small" color="dark-subtle">
        not scanned
      </GravityText>
    );
  }
  return (
    <GravityText size="xx-small" color="dark-subtle">
      {count} instance{count === 1 ? '' : 's'}
    </GravityText>
  );
}

function KV({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="kv-row">
      <GravityText size="xx-small" color="dark-subtle" className="kv-label">
        {label}
      </GravityText>
      <GravityText size="xx-small" weight="medium" className="kv-value">
        {String(value)}
      </GravityText>
    </div>
  );
}

export function App() {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [migrate, setMigrate] = useState<MigrateState>({ kind: 'idle' });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [copied, setCopied] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage;
      if (!msg) return;
      switch (msg.type) {
        case 'find-results': {
          setScanning(false);
          setScanned(true);
          setCandidates(msg.candidates ?? []);
          setNotes(msg.notes ?? []);
          if (msg.resolution) {
            setResolution(msg.resolution);
          }
          break;
        }
        case 'resolution-updated':
          setResolution(msg.resolution);
          break;
        case 'progress':
          setMigrate({ kind: 'running', done: msg.done, total: msg.total });
          // Every progress tick carries the same summary/exceptions shape as
          // the final report, so the Report section is always showing a real,
          // accurate partial result — not just a done/total counter — even if
          // the run never reaches a final 'report' message.
          setSummary(msg.summary ?? null);
          setExceptions(msg.exceptions ?? []);
          break;
        case 'report':
          setMigrate({ kind: 'done' });
          setSummary(msg.summary ?? null);
          setExceptions(msg.exceptions ?? []);
          break;
        case 'error':
          if (scanning) {
            setScanning(false);
            setNotes([msg.message]);
          } else {
            setMigrate({ kind: 'error', message: msg.message });
          }
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [scanning]);

  const countFor = (role: Role) => candidates.filter((c) => c.role === role).reduce((n, c) => n + c.count, 0);
  const oldCount = countFor('old');
  const newCount = countFor('new');
  const unrecognised = candidates.filter((c) => c.role === null);
  const scanMessage = notes[0] ?? (scanned && candidates.length === 0 ? 'No matching instances found in the current selection.' : null);


  const scan = () => {
    setScanning(true);
    setNotes([]);
    post({ type: 'find-components', scope: { mode: 'selection' } });
  };

  // notes[] also carries the scan-time gate-failure preview (missing leading
  // type / action component) whenever both main components ARE resolved, so
  // this correctly blocks Migrate for that case too, not just unresolved refs.
  const canMigrate = !!resolution?.oldMainKey && !!resolution?.newMainKey && notes.length === 0 && migrate.kind !== 'running';

  const runMigrate = () => {
    setMigrate({ kind: 'running', done: 0, total: 0 });
    setSummary(null);
    setExceptions([]);
    post({ type: 'migrate', scope: { mode: 'selection' } });
  };

  const copyResults = () => {
    const lines = [
      `Scope: ${summary?.scope ?? 'n/a'}`,
      `Source instances: ${summary?.source ?? 0}`,
      `Migrated: ${summary?.migrated ?? 0}`,
      `Skipped: ${summary?.skipped ?? 0}`,
      `Failed: ${summary?.failed ?? 0}`,
      ...(summary && summary.manualReview > 0 ? [`Manual review: ${summary.manualReview}`] : []),
      ...(exceptions.length > 0 ? ['', 'Exceptions:', ...exceptions.map((e) => `${e.id}: ${e.status}, ${e.reason}`)] : []),
    ];
    const text = lines.join('\n');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    } else {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <>
      <GravityCallout
        type="info"
        inline={false}
        message="Migrate no more than 200 instances at once. Larger runs take much longer and are harder to review."
      />
      <div className="app">
      <GravityPanel heading="1. Select and Scan">
        <div slot="body" className="stack">
          <GravityText size="x-small" color="dark-subtle">
            Select the frames or instances you want to migrate, then scan to resolve the old and new components.
          </GravityText>
          <div className="stack-tight">
            <div className="row-card">
              <GravityText size="x-small" weight="medium">
                gravity-list-entry
              </GravityText>
              <CountBadge count={oldCount} scanned={scanned} />
            </div>
            <div className="row-card">
              <GravityText size="x-small" weight="medium">
                gravity-list-entry-new
              </GravityText>
              <CountBadge count={newCount} scanned={scanned} />
            </div>
            {scanMessage && (
              <GravityText size="xx-small" weight="medium" color="negative">
                {scanMessage}
              </GravityText>
            )}
            {unrecognised.map((c) => (
              <div className="row-card" key={c.key}>
                <GravityText size="x-small" weight="medium">
                  {c.name}
                </GravityText>
                <GravityText size="xx-small" color="dark-subtle">
                  {c.count} instance{c.count === 1 ? '' : 's'}
                </GravityText>
              </div>
            ))}
          </div>
          <GravityButton type="primary" size="small" width="full-width" busy={scanning} onButtonClicked={scan}>
            Scan selection
          </GravityButton>
        </div>
      </GravityPanel>

      <GravityPanel heading="2. Migrate">
        <div slot="body" className="stack">
          <GravityText size="x-small" color="dark-subtle">
            Review the results above, then migrate your current selection.
          </GravityText>
          {migrate.kind === 'error' && <GravityCallout type="warning" showIcon iconName="warning" title="Migration failed" message={migrate.message} />}
          {(migrate.kind === 'running' || migrate.kind === 'done') && (
            <GravityAccordionItem
              heading="Report"
              type="boxed"
              size="small"
              expanded={resultsOpen}
              actions={[{ id: 'copy', iconName: copied ? 'check' : 'copy', iconOnly: true }]}
              onAccordionItemExpanded={(e: CustomEvent) => {
                const d = e.detail as { expanded?: boolean } | boolean;
                setResultsOpen(typeof d === 'boolean' ? d : !!d?.expanded);
              }}
              onActionClicked={() => copyResults()}
            >
              <div slot="meta">
                <GravityText size="xx-small" color="dark-subtle" className="nowrap">
                  {migrate.kind === 'running'
                    ? migrate.total > 0
                      ? `${migrate.done}/${migrate.total}`
                      : 'starting'
                    : summary
                      ? `${summary.migrated} migrated, ${summary.failed} failed`
                      : ''}
                </GravityText>
              </div>
              <div slot="body" className="stack">
                {summary ? (
                  <div className="stack-xx-tight">
                    <KV label="Scope" value={summary.scope} />
                    <KV label="Source instances" value={summary.source} />
                    <KV label="Migrated" value={summary.migrated} />
                    <KV label="Skipped" value={summary.skipped} />
                    <KV label="Failed" value={summary.failed} />
                    {summary.manualReview > 0 && <KV label="Manual review" value={summary.manualReview} />}
                  </div>
                ) : null}
                {exceptions.length > 0 && (
                  <div className="details stack-tight">
                    {exceptions.map((e, i) => (
                      <div key={i} className="stack-none">
                        <GravityText size="xx-small" weight="medium">
                          {e.id}
                        </GravityText>
                        <GravityText size="xx-small" color="dark-subtle">
                          {e.reason}
                        </GravityText>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </GravityAccordionItem>
          )}
          <GravityButton type="primary" size="small" width="full-width" disabled={!canMigrate} onButtonClicked={runMigrate}>
            Migrate
          </GravityButton>
        </div>
      </GravityPanel>

      </div>
    </>
  );
}

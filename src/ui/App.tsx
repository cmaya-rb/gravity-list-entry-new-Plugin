import { useEffect, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Badge } from './components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
import { cn } from './lib/utils';

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

const MAX_BATCH = 100;
const LEADING_TYPES: LeadingType[] = ['image', 'icon', 'avatar', 'flag'];

const post = (msg: unknown) => parent.postMessage({ pluginMessage: msg }, '*');

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3">
      <span className="truncate text-sm">{label}</span>
      {children}
    </div>
  );
}

function CountBadge({ count, scanned }: { count: number; scanned: boolean }) {
  if (!scanned) return <Badge variant="secondary">—</Badge>;
  return (
    <Badge variant={count > 0 ? 'success' : 'danger'}>
      {count} instance{count === 1 ? '' : 's'}
    </Badge>
  );
}

function CheckRow({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant={ok ? 'success' : 'danger'} className="font-mono">
        {ok ? okText : badText}
      </Badge>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

export function App() {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [migrate, setMigrate] = useState<MigrateState>({ kind: 'idle' });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage;
      if (!msg) return;
      switch (msg.type) {
        case 'find-results':
          setScanning(false);
          setScanned(true);
          setCandidates(msg.candidates ?? []);
          setNotes(msg.notes ?? []);
          if (msg.resolution) setResolution(msg.resolution);
          break;
        case 'resolution-updated':
          setResolution(msg.resolution);
          break;
        case 'progress':
          setMigrate({ kind: 'running', done: msg.done, total: msg.total });
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
  // One message at a time: the sandbox sends a note per missing component,
  // which stacks with the generic "nothing found" line when both are missing.
  const scanMessage = scanned && candidates.length === 0 ? 'No matching instances found in the current selection.' : notes[0] ?? null;

  const scan = () => {
    setScanning(true);
    setNotes([]);
    post({ type: 'find-components', scope: { mode: 'selection' } });
  };

  const canMigrate = !!resolution?.oldMainKey && !!resolution?.newMainKey && migrate.kind !== 'running';

  const runMigrate = () => {
    if (!window.confirm('This will modify the file: replace matched gravity-list-entry instances with gravity-list-entry-new. Continue?')) return;
    setMigrate({ kind: 'running', done: 0, total: 0 });
    setSummary(null);
    setExceptions([]);
    post({ type: 'migrate', scope: { mode: 'selection' }, maxBatch: MAX_BATCH });
  };

  const statusText =
    migrate.kind === 'idle'
      ? 'not started'
      : migrate.kind === 'running'
        ? migrate.total > 0
          ? `${migrate.done}/${migrate.total} migrated`
          : 'starting…'
        : migrate.kind === 'done'
          ? 'done'
          : 'error';

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>1. Find Components</CardTitle>
          <CardDescription>Scans the current selection and resolves the old and new references automatically from the component name.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button variant="outline" className="mb-1 w-full" onClick={scan} disabled={scanning}>
            {scanning && <Loader2 className="animate-spin" />}
            {scanning ? 'Scanning…' : 'Scan selection'}
          </Button>

          <Row label="gravity-list-entry">
            <CountBadge count={oldCount} scanned={scanned} />
          </Row>
          <Row label="gravity-list-entry-new">
            <CountBadge count={newCount} scanned={scanned} />
          </Row>
          {unrecognised.map((c) => (
            <Row key={c.key} label={c.name}>
              <Badge variant="secondary">{c.count} · unrecognised name</Badge>
            </Row>
          ))}

          {scanMessage && <p className="text-xs text-red-600">{scanMessage}</p>}

          <Collapsible open={resolutionOpen} onOpenChange={setResolutionOpen} className="rounded-lg border">
            <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-3 text-sm font-medium">
              Resolution Check
              <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', resolutionOpen && 'rotate-180')} />
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t bg-muted/40 px-3 py-3 font-mono text-xs">
              <CheckRow label="Old main" ok={!!resolution?.oldMainKey} okText="set" badText="missing" />
              <CheckRow label="New main" ok={!!resolution?.newMainKey} okText="set" badText="missing" />
              <CheckRow label="Old leading" ok={!!resolution?.oldLeadingSetKey} okText="found" badText="not found" />
              {LEADING_TYPES.map((t) => (
                <CheckRow key={t} label={`Leading “${t}”`} ok={!!resolution?.newLeadingTypeKeys?.[t]} okText="resolved" badText="unresolved" />
              ))}
              <CheckRow label="Action component" ok={!!resolution?.newActionKey} okText="resolved" badText="unresolved" />
              {resolution?.diagnostics?.length ? (
                <div className="mt-2 flex flex-col gap-1 border-t pt-2 font-sans">
                  {resolution.diagnostics.map((d, i) => (
                    <p key={i} className="text-xs text-red-600">
                      {d}
                    </p>
                  ))}
                </div>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Migrate</CardTitle>
          <CardDescription>Runs against your current selection in Figma. Migrate in small batches (max {MAX_BATCH} per run).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Row label="Status">
            <span className={cn('shrink-0 text-xs', migrate.kind === 'error' ? 'text-red-600' : 'text-muted-foreground')}>{statusText}</span>
          </Row>
          {migrate.kind === 'error' && <p className="text-xs text-red-600">{migrate.message}</p>}
          <Button className="w-full" onClick={runMigrate} disabled={!canMigrate}>
            {migrate.kind === 'running' && <Loader2 className="animate-spin" />}
            Migrate
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Results</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="rounded-lg border bg-muted/40 px-3 py-3 font-mono text-xs">
            {summary ? (
              <>
                <KV label="Scope" value={summary.scope} />
                <KV label="Source instances" value={summary.source} />
                <KV label="Migrated" value={summary.migrated} />
                <KV label="Skipped" value={summary.skipped} />
                <KV label="Failed" value={summary.failed} />
                {summary.manualReview > 0 && <KV label="Manual review" value={summary.manualReview} />}
              </>
            ) : (
              <span className="text-muted-foreground">No run yet.</span>
            )}
          </div>
          {exceptions.length > 0 && (
            <div className="max-h-48 overflow-auto rounded-lg border px-3 py-2 text-xs">
              {exceptions.map((e, i) => (
                <div key={i} className="border-b py-1.5 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={e.status === 'failed' ? 'danger' : 'secondary'}>{e.status}</Badge>
                    <span className="font-mono text-muted-foreground">{e.id}</span>
                  </div>
                  <p className="mt-1 break-words text-muted-foreground">{e.reason}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

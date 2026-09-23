// Gravity List Entry migration plugin.
// Implements gravity-list-entry-new-migration.md: resolve → snapshot →
// pre-migration gate → per-instance migration → validation → report.

figma.showUI(__html__, { width: 400, height: 720 });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LeadingType = 'image' | 'icon' | 'avatar' | 'flag';

interface LeadingKeyInfo {
  key: string;
  name: string;
}

interface Resolution {
  oldMainKey: string;
  oldMainName: string;
  newMainKey: string;
  newMainName: string;
  oldLeadingSetKey: string | null;
  newLeadingTypeKeys: Partial<Record<LeadingType, LeadingKeyInfo>>;
  newLeadingSetKey: string | null;
  newActionKey: LeadingKeyInfo | null;
  diagnostics: string[];
}

interface LeadingSnapshot {
  type: LeadingType | 'unknown';
  imageFills?: Paint[];
  iconName?: string;
  iconIsDefault?: boolean;
  avatarInitials?: string;
  avatarPicture?: boolean;
  avatarPictureFill?: Paint[];
  flagCountryName?: string;
  flagCode?: string;
}

interface ActionSnapshot {
  present: boolean;
  label?: string;
  iconName?: string;
  iconPosition?: string;
}

interface VariantSnapshot {
  width: string | null; // "~ width"
  type: string | null;
  presentational: boolean;
  state: string | null; // "~ state"
  selected: boolean;
  action: boolean;
}

interface InstanceSnapshot {
  nodeId: string;
  pageId: string;
  pageName: string;
  parentId: string;
  siblingIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  layoutAlign?: string;
  layoutPositioning?: string;
  constraints?: Constraints;
  reactions?: unknown;
  variant: VariantSnapshot;
  heading: string | null;
  description: string | null;
  bool: {
    leading: boolean | null;
    description: boolean | null;
    focus: boolean | null;
    switchesContext: boolean | null;
    meta: boolean | null;
    persistent: boolean | null;
  };
  leading: LeadingSnapshot | null;
  action: ActionSnapshot;
  metaSlotInstance: InstanceNode | null; // live ref to the instance slotted into meta — carried through, never re-resolved by key
  metaDiagnostic: string | null; // set when metaSlotInstance couldn't be resolved, describing what was found instead
}

type OutcomeStatus = 'migrated' | 'skipped' | 'already-migrated' | 'failed' | 'manual-review';

interface OutcomeRow {
  sourceNodeId: string;
  replacementNodeId?: string;
  status: OutcomeStatus;
  reason: string;
}

type ScopeMode = 'selection' | 'current-page' | 'all-pages' | 'named-pages';

interface ScopeConfig {
  mode: ScopeMode;
  pageNames?: string[];
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

let resolution: Resolution | null = null;

const STORAGE_KEY = () => `gravity-list-entry-migration:${figma.fileKey ?? 'local'}`;

// Cache of every component/component-set already reachable in the current
// document (any page), keyed by its stable key. Rebuilt once per audit/
// migrate run so we prefer nodes already available in the current file over
// figma.importComponentByKeyAsync, which only resolves components actually
// published to a team library — per the user's requirement to check what's
// already available in the current file first.
let componentIndex: Map<string, ComponentNode | ComponentSetNode> | null = null;
// Some target components are themselves private/nested (like leading) and
// can never be reached via importComponentByKeyAsync or by scanning for
// freestanding COMPONENT/COMPONENT_SET definitions — the only way to reach
// them is through an INSTANCE that already uses one, elsewhere in the
// document. That scan is expensive (async per instance), so it only runs
// once, lazily, the first time the fast paths fail to resolve a key.
let instanceIndexBuilt = false;

async function buildComponentIndex(): Promise<Map<string, ComponentNode | ComponentSetNode>> {
  await figma.loadAllPagesAsync();
  const index = new Map<string, ComponentNode | ComponentSetNode>();
  function visit(node: BaseNode): void {
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      index.set((node as ComponentNode | ComponentSetNode).key, node as ComponentNode | ComponentSetNode);
    }
    if ('children' in node) {
      for (const child of (node as unknown as ChildrenMixin).children) visit(child as unknown as BaseNode);
    }
  }
  for (const page of figma.root.children) visit(page);
  return index;
}

async function indexInstancesByMainComponentKey(index: Map<string, ComponentNode | ComponentSetNode>): Promise<void> {
  const instances: InstanceNode[] = [];
  function visit(node: BaseNode): void {
    if ((node as SceneNode).type === 'INSTANCE') instances.push(node as InstanceNode);
    if ('children' in node) {
      for (const child of (node as unknown as ChildrenMixin).children) visit(child as unknown as BaseNode);
    }
  }
  for (const page of figma.root.children) visit(page);
  // Dispatched in parallel — sequential awaits over potentially thousands of
  // nested instances (buttons, badges, spacers inside panel mockups, etc.)
  // would make this feel hung rather than merely slow.
  await Promise.all(
    instances.map(async (inst) => {
      try {
        const main = await inst.getMainComponentAsync();
        if (main && !index.has(main.key)) index.set(main.key, main);
      } catch {
        // unresolved instance (e.g. detached remote source) — skip it
      }
    })
  );
}

async function resolveComponentByKey(key: string): Promise<ComponentNode | ComponentSetNode> {
  if (!componentIndex) componentIndex = await buildComponentIndex();
  let local = componentIndex.get(key);
  if (local) return local;

  if (!instanceIndexBuilt) {
    await indexInstancesByMainComponentKey(componentIndex);
    instanceIndexBuilt = true;
    local = componentIndex.get(key);
    if (local) return local;
  }

  try {
    return await figma.importComponentByKeyAsync(key);
  } catch {
    return await figma.importComponentSetByKeyAsync(key);
  }
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function normalizeBase(name: string): string {
  // The "~" prefix is a meaningful part of this design system's naming
  // convention (e.g. "~ description" the boolean toggle vs "description"
  // the text content) — it must NOT be stripped, or two distinct properties
  // collapse to the same base name and findProp() can match the wrong one.
  return name.trim().toLowerCase().replace(/^~\s+/, '~');
}

function findChildByName(node: SceneNode, name: string): SceneNode | null {
  if (!('children' in node)) return null;
  const target = name.toLowerCase();
  for (const child of (node as ChildrenMixin).children as SceneNode[]) {
    if (child.name.toLowerCase() === target) return child;
  }
  return null;
}

// Like findChildByName, but also matches Figma's default layer name for an
// un-renamed instance of a private sub-component: "_OwnerName / partName"
// (confirmed: some placed instances show "leading" verbatim, others show
// "_gravity-list-entry / leading" for the exact same logical part,
// depending on whether that specific layer was ever manually renamed).
function findChildByStructuralName(node: SceneNode, name: string): SceneNode | null {
  const exact = findChildByName(node, name);
  if (exact) return exact;
  if (!('children' in node)) return null;
  const target = name.toLowerCase();
  for (const child of (node as ChildrenMixin).children as SceneNode[]) {
    const parts = child.name.split('/');
    const lastPart = parts[parts.length - 1]?.trim().toLowerCase();
    if (parts.length > 1 && lastPart === target) return child;
  }
  return null;
}

function findChildByPath(node: SceneNode, path: string[]): SceneNode | null {
  let current: SceneNode | null = node;
  for (const segment of path) {
    if (!current) return null;
    current = findChildByName(current, segment);
  }
  return current;
}

function findActionsFrame(node: SceneNode): SceneNode | null {
  return findChildByName(node, 'actions') || findChildByPath(node, ['content-container', 'actions']);
}

// The avatar's picture rectangle is sometimes a direct child of the avatar
// instance, sometimes wrapped one level deeper in a "picture-container"
// frame (confirmed structure: avatar > picture-container > picture) — the
// initials rectangle is nested the same way, in an "initials-container".
// Try direct first, then the wrapped path, so this works for either shape.
function findAvatarPicture(avatarNode: SceneNode): SceneNode | null {
  return findChildByName(avatarNode, 'picture') || findChildByPath(avatarNode, ['picture-container', 'picture']);
}

function findDescendantInstance(node: SceneNode): InstanceNode | null {
  if (node.type === 'INSTANCE') return node;
  if (!('children' in node)) return null;
  for (const child of (node as ChildrenMixin).children as SceneNode[]) {
    const found = findDescendantInstance(child);
    if (found) return found;
  }
  return null;
}

interface PropEntry {
  key: string;
  value: string | boolean;
  type: string;
}

function findProp(instance: InstanceNode, base: string): PropEntry | null {
  const props = instance.componentProperties || {};
  const target = normalizeBase(base);
  for (const key of Object.keys(props)) {
    const nb = normalizeBase(key.split('#')[0]);
    if (nb === target) {
      const p = props[key];
      return { key, value: p.value as string | boolean, type: p.type };
    }
  }
  return null;
}

// Tries multiple spellings of the same logical property — this file mixes
// kebab-case (icon-name, country-name) with at least one documented
// camelCase name (switchesContext) that may not match the actual Figma
// property key.
function findPropAny(instance: InstanceNode, bases: string[]): PropEntry | null {
  for (const base of bases) {
    const found = findProp(instance, base);
    if (found) return found;
  }
  return null;
}

// The old component's meta wrapper is named "meta-container" when
// `persistent` is true, but "meta-wrap" when `persistent` is false — the
// non-persistent variant has a structurally different layout (actions only
// reveal on hover), not just a hidden node. Both names must be treated as
// the same slot, or a non-persistent instance's real meta content is
// reported as missing even though it's present.
const META_CONTAINER_NAMES = ['meta-container', 'meta-wrap'];

function findMetaContainer(node: SceneNode): SceneNode | null {
  for (const name of META_CONTAINER_NAMES) {
    const direct = findChildByStructuralName(node, name);
    if (direct) return direct;
  }
  const contentContainer = findChildByName(node, 'content-container');
  if (!contentContainer) return null;
  for (const name of META_CONTAINER_NAMES) {
    const nested = findChildByStructuralName(contentContainer, name);
    if (nested) return nested;
  }
  return null;
}

async function getOwningKey(component: ComponentNode): Promise<{ key: string; name: string }> {
  if (component.parent && component.parent.type === 'COMPONENT_SET') {
    const set = component.parent as ComponentSetNode;
    return { key: set.key, name: set.name };
  }
  return { key: component.key, name: component.name };
}

async function getInstanceOwningKey(instance: InstanceNode): Promise<{ key: string; name: string } | null> {
  const main = await instance.getMainComponentAsync();
  if (!main) return null;
  return getOwningKey(main);
}

// The specific component's OWN key — never collapsed to its owning set's
// key. Use this (not getInstanceOwningKey) whenever comparing against a
// per-variant key like the ones in res.newLeadingTypeKeys.
async function getInstanceComponentKey(instance: InstanceNode): Promise<string | null> {
  const main = await instance.getMainComponentAsync();
  return main ? main.key : null;
}

function fillsSnapshot(node: SceneNode | null): Paint[] | undefined {
  if (!node || !('fills' in node)) return undefined;
  const fills = (node as GeometryMixin).fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return undefined;
  return (fills as Paint[]).map((f) => JSON.parse(JSON.stringify(f)));
}

// ---------------------------------------------------------------------------
// Resolution step — reads real component keys live from confirmed reference
// instances. Never guesses a key from a display name; names are only used to
// pick candidates for the human to confirm (safety contract rule 5).
// ---------------------------------------------------------------------------

interface ReferenceNode {
  owningKey: string;
  owningName: string;
  // Always an instance, even when the picked node was a bare component/set
  // definition (e.g. resolving directly inside the library file, where
  // there may be no placed instance at all) — created as scratch scaffolding
  // for introspection and always cleaned up by the caller.
  instance: InstanceNode;
  cleanup: () => void;
}

async function toReferenceInstance(nodeId: string): Promise<ReferenceNode> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error('Selected node no longer exists.');

  if (node.type === 'INSTANCE') {
    const instance = node as InstanceNode;
    const owning = await getInstanceOwningKey(instance);
    if (!owning) throw new Error('Could not read the main component of the selected instance.');
    return { owningKey: owning.key, owningName: owning.name, instance, cleanup: () => {} };
  }

  if (node.type === 'COMPONENT_SET') {
    const set = node as ComponentSetNode;
    const temp = set.defaultVariant.createInstance();
    temp.x = set.x;
    temp.y = set.y - set.height - 200;
    return { owningKey: set.key, owningName: set.name, instance: temp, cleanup: () => temp.remove() };
  }

  if (node.type === 'COMPONENT') {
    const comp = node as ComponentNode;
    const owning = await getOwningKey(comp);
    const temp = comp.createInstance();
    temp.x = comp.x;
    temp.y = comp.y - comp.height - 200;
    return { owningKey: owning.key, owningName: owning.name, instance: temp, cleanup: () => temp.remove() };
  }

  throw new Error('Selected node must be a component instance, component, or component set.');
}

// Reads leading types DIRECTLY from the leading component-set's own variant
// children — never from cycling/inspecting a list-entry instance's current
// leading. Cycling trusts whatever the reference instance's leading
// currently happens to be, which can silently be the OLD leading component
// even while the "type" value coincidentally matches (confirmed case: right
// type, wrong component) — this reads the ground truth directly instead.
// Reads leading types DIRECTLY off a component set's own variant children —
// deterministic, no cycling/scanning needed. Shared by the explicit
// "Capture selection as LEADING SET" action and by resolveNewReference's
// automatic attempt on whatever leading the NEW reference already has.
function readLeadingTypesFromSet(set: ComponentSetNode): Partial<Record<LeadingType, LeadingKeyInfo>> {
  const result: Partial<Record<LeadingType, LeadingKeyInfo>> = {};
  for (const child of set.children as ComponentNode[]) {
    const vp = child.variantProperties || {};
    const typeKey = Object.keys(vp).find((k) => normalizeBase(k) === 'type');
    const t = typeKey ? (vp[typeKey]?.toLowerCase() as LeadingType) : null;
    if (t && (['image', 'icon', 'avatar', 'flag'] as string[]).includes(t)) {
      result[t] = { key: child.key, name: child.name };
    }
  }
  return result;
}

// The old/new roles are a fixed naming convention for this migration, not a
// per-consumer choice — "gravity-list-entry" is always old, "gravity-list-
// entry-new" is always new. Detecting the role from the selected node's own
// owning component name removes the need for the consumer to tell us which
// is which.
function detectReferenceRoleFromName(name: string): 'old' | 'new' | null {
  const n = name.trim().toLowerCase();
  if (n === 'gravity-list-entry-new') return 'new';
  if (n === 'gravity-list-entry') return 'old';
  return null;
}

async function resolveOldReference(
  nodeId: string
): Promise<{ mainKey: string; mainName: string; leadingSetKey: string | null; diagnostics: string[] }> {
  const ref = await toReferenceInstance(nodeId);
  const diagnostics: string[] = [];
  const childNames = (n: SceneNode | null) => (n && 'children' in n ? (n as ChildrenMixin).children.map((c) => `${c.name} [${c.type}]`).join(', ') : '(none)');
  try {
    let leadingSetKey: string | null = null;
    const leadingWrap = findChildByStructuralName(ref.instance, 'leading');
    if (!leadingWrap) {
      diagnostics.push(`OLD: no "leading" child found. Root children: ${childNames(ref.instance)}`);
    } else {
      const leadingInstance = findDescendantInstance(leadingWrap);
      if (!leadingInstance) {
        diagnostics.push(`OLD: found a "leading" child (type ${leadingWrap.type}) but it isn't/doesn't contain an instance.`);
      } else {
        const leadingOwning = await getInstanceOwningKey(leadingInstance);
        if (!leadingOwning) {
          diagnostics.push('OLD: found the leading instance but could not read its main component (getMainComponentAsync returned null — possibly detached).');
        }
        leadingSetKey = leadingOwning?.key ?? null;
      }
    }
    return { mainKey: ref.owningKey, mainName: ref.owningName, leadingSetKey, diagnostics };
  } finally {
    ref.cleanup();
  }
}

async function resolveNewReference(nodeId: string, oldLeadingSetKey: string | null): Promise<{
  mainKey: string;
  mainName: string;
  leadingTypeKeys: Partial<Record<LeadingType, LeadingKeyInfo>>;
  leadingSetKey: string | null;
  actionKey: LeadingKeyInfo | null;
  diagnostics: string[];
}> {
  const ref = await toReferenceInstance(nodeId);

  // Work on a throwaway clone so the reference (real or scratch) is never
  // mutated while we cycle leading variants to discover their keys.
  const clone = ref.instance.clone();
  clone.x = ref.instance.x + ref.instance.width + 400;
  clone.y = ref.instance.y;

  const leadingTypeKeys: Partial<Record<LeadingType, LeadingKeyInfo>> = {};
  let leadingSetKey: string | null = null;
  let actionKey: LeadingKeyInfo | null = null;
  const diagnostics: string[] = [];
  const childNames = (n: SceneNode | null) => (n && 'children' in n ? (n as ChildrenMixin).children.map((c) => `${c.name} [${c.type}]`).join(', ') : '(none)');

  try {
    // The reference's own variant may have `~actions: false`, which can hide
    // or omit the actions frame entirely. Force it on for this throwaway
    // clone so the action can actually be found and inspected.
    const actionsBoolProp = findProp(clone, '~ actions') || findProp(clone, 'actions');
    if (actionsBoolProp) {
      try {
        clone.setProperties({ [actionsBoolProp.key]: true });
      } catch {
        // ignore — fall through to diagnostics below if this leaves no actions frame
      }
    }

    const leadingWrap = findChildByStructuralName(clone, 'leading');
    const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;

    // Auto-resolve, but verified rather than blindly trusted. Two
    // independent checks, either is sufficient — this design system
    // consistently names owned sub-components "{MainComponentName} /
    // partName" (confirmed for leading, status, meta-slot, action), so a
    // leading set name prefixed with the confirmed main component name
    // (ref.owningName) is strong evidence on its own; comparing against the
    // OLD leading's key (when available) is an additional, stronger check.
    // Neither available means: refuse rather than silently trust.
    if (leadingInstance) {
      const leadingMain = await leadingInstance.getMainComponentAsync();
      const leadingSet = leadingMain?.parent?.type === 'COMPONENT_SET' ? (leadingMain.parent as ComponentSetNode) : null;
      if (!leadingSet) {
        diagnostics.push('Could not determine the leading\'s component set.');
      } else if (oldLeadingSetKey && leadingSet.key === oldLeadingSetKey) {
        diagnostics.push(
          'This reference\'s leading is still on the OLD leading component set — cannot auto-resolve from it. Use "Capture selection as LEADING SET" on a confirmed-correct leading instead.'
        );
      } else if (oldLeadingSetKey && leadingSet.key !== oldLeadingSetKey) {
        Object.assign(leadingTypeKeys, readLeadingTypesFromSet(leadingSet)); // definitely not old — accept
        leadingSetKey = leadingSet.key;
      } else if (leadingSet.name.toLowerCase().includes(ref.owningName.toLowerCase())) {
        Object.assign(leadingTypeKeys, readLeadingTypesFromSet(leadingSet)); // owned-sub-component naming convention matches — accept
        leadingSetKey = leadingSet.key;
      } else {
        diagnostics.push(
          `Cannot verify this leading automatically — its component set ("${leadingSet.name}") isn't named as owned by "${ref.owningName}". Capture OLD first, or use "Capture selection as LEADING SET" explicitly.`
        );
      }
    } else {
      diagnostics.push(`No "leading" child found. Root children: ${childNames(clone)}`);
    }

    const actionsFrame = findActionsFrame(clone);
    if (actionsFrame && 'children' in actionsFrame) {
      const firstAction = (actionsFrame as ChildrenMixin).children.find(
        (c) => c.type === 'INSTANCE' && /action/i.test(c.name) && !/overflow/i.test(c.name)
      ) as InstanceNode | undefined;
      if (firstAction) {
        const actionMain = await firstAction.getMainComponentAsync();
        if (actionMain) actionKey = await getOwningKey(actionMain);
      } else {
        diagnostics.push(`Found actions frame "${actionsFrame.name}" but no child instance matched /action/i. Its children: ${childNames(actionsFrame)}`);
      }
    } else {
      const contentContainer = findChildByName(clone, 'content-container');
      diagnostics.push(
        `No "actions" or "action-container" frame found. Root children: ${childNames(clone)}` +
          (contentContainer ? `. content-container children: ${childNames(contentContainer)}` : '')
      );
    }
  } finally {
    clone.remove();
    ref.cleanup();
  }

  // Primary method (per spec, tried first — cycling on one clone above is
  // the secondary method and only ever reaches types achievable from that
  // one instance's specific variant combination): scan the document for
  // OTHER instances already on this same new main component and borrow
  // their leading types directly, filling in anything still missing.
  const missing = (['image', 'icon', 'avatar', 'flag'] as LeadingType[]).filter((t) => !leadingTypeKeys[t]);
  if (missing.length > 0) {
    await scanForLeadingTypeExamples(ref.owningKey, leadingTypeKeys);
  }

  return { mainKey: ref.owningKey, mainName: ref.owningName, leadingTypeKeys, leadingSetKey, actionKey, diagnostics };
}

async function scanForLeadingTypeExamples(newMainKey: string, leadingTypeKeys: Partial<Record<LeadingType, LeadingKeyInfo>>): Promise<void> {
  await figma.loadAllPagesAsync();
  const instances: InstanceNode[] = [];
  function visit(node: BaseNode): void {
    if ((node as SceneNode).type === 'INSTANCE') instances.push(node as InstanceNode);
    if ('children' in node) {
      for (const child of (node as unknown as ChildrenMixin).children) visit(child as unknown as BaseNode);
    }
  }
  for (const page of figma.root.children) visit(page);

  await Promise.all(
    instances.map(async (inst) => {
      const owning = await getInstanceOwningKey(inst);
      if (!owning || owning.key !== newMainKey) return;
      const leadingWrap = findChildByStructuralName(inst, 'leading');
      const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
      if (!leadingInstance) return;
      const typeProp = findProp(leadingInstance, 'type');
      const t = typeProp ? (String(typeProp.value).toLowerCase() as LeadingType) : null;
      if (!t || !(['image', 'icon', 'avatar', 'flag'] as string[]).includes(t) || leadingTypeKeys[t]) return;
      const leadingMain = await leadingInstance.getMainComponentAsync();
      if (leadingMain) leadingTypeKeys[t] = { key: leadingMain.key, name: leadingMain.name };
    })
  );
}

// ---------------------------------------------------------------------------
// Scope + collection
// ---------------------------------------------------------------------------

async function getScopeRoots(scope: ScopeConfig): Promise<readonly BaseNode[]> {
  if (scope.mode === 'selection') return figma.currentPage.selection;
  if (scope.mode === 'current-page') return [figma.currentPage];
  if (scope.mode === 'all-pages') {
    await figma.loadAllPagesAsync();
    return figma.root.children;
  }
  if (scope.mode === 'named-pages') {
    await figma.loadAllPagesAsync();
    const names = new Set((scope.pageNames || []).map((n) => n.trim().toLowerCase()));
    return figma.root.children.filter((p) => names.has(p.name.toLowerCase()));
  }
  return [];
}

async function collectInstances(roots: readonly BaseNode[]): Promise<InstanceNode[]> {
  const out: InstanceNode[] = [];
  async function visit(node: BaseNode): Promise<void> {
    if ((node as SceneNode).type === 'INSTANCE') out.push(node as InstanceNode);
    if ('children' in node) {
      for (const child of (node as unknown as ChildrenMixin).children) {
        await visit(child as unknown as BaseNode);
      }
    }
  }
  for (const r of roots) await visit(r);
  return out;
}

async function classifyInstances(instances: InstanceNode[], res: Resolution) {
  const migratable: InstanceNode[] = [];
  const alreadyMigrated: InstanceNode[] = [];
  const unrelated: InstanceNode[] = [];
  // Dispatched in parallel — a page built from nested panel mockups can
  // easily contain thousands of instances; sequential awaits here would be
  // slow enough to look broken rather than just slow.
  const owningKeys = await Promise.all(instances.map((inst) => getInstanceOwningKey(inst)));
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const owning = owningKeys[i];
    if (!owning) {
      unrelated.push(inst);
    } else if (owning.key === res.newMainKey) {
      alreadyMigrated.push(inst);
    } else if (owning.key === res.oldMainKey) {
      migratable.push(inst);
    } else {
      unrelated.push(inst);
    }
  }
  return { migratable, alreadyMigrated, unrelated };
}

interface CandidateInfo {
  key: string;
  name: string;
  count: number;
  exampleNodeId: string;
  pageName: string;
  role: 'old' | 'new' | null; // detected from the component name, same convention capture uses
}

// Scans the given scope for instances AND bare component/component-set
// definitions (the latter matters when running inside the library file
// itself, where the new component may exist only as its master definition
// with no instance placed anywhere yet). Groups by real owning key and
// returns one example node per group. This only narrows candidates for the
// human to confirm — resolveOldReference/resolveNewReference still read the
// actual key live from whichever node is chosen, never from the matched name.
async function collectCandidateNodes(roots: readonly BaseNode[]): Promise<(InstanceNode | ComponentNode | ComponentSetNode)[]> {
  const out: (InstanceNode | ComponentNode | ComponentSetNode)[] = [];
  async function visit(node: BaseNode): Promise<void> {
    const t = (node as SceneNode).type;
    if (t === 'INSTANCE') {
      out.push(node as InstanceNode);
      // Do NOT stop here — a list-entry can be nested inside another
      // instance (e.g. placed as content inside a panel mockup, which
      // varies project to project), so traversal must continue into this
      // instance's own children too, or nested matches are invisible.
    } else if (t === 'COMPONENT_SET') {
      out.push(node as ComponentSetNode);
      return; // variants inside an already-matched set aren't useful as separate candidates
    } else if (t === 'COMPONENT') {
      const comp = node as ComponentNode;
      if (!comp.parent || comp.parent.type !== 'COMPONENT_SET') out.push(comp);
      return;
    }
    if ('children' in node) {
      for (const child of (node as unknown as ChildrenMixin).children) {
        await visit(child as unknown as BaseNode);
      }
    }
  }
  for (const r of roots) await visit(r);
  return out;
}

async function findComponentCandidates(scope: ScopeConfig): Promise<CandidateInfo[]> {
  const roots = await getScopeRoots(scope);
  const nodes = await collectCandidateNodes(roots);
  // Dispatched in parallel for the same reason as classifyInstances above —
  // panel-mockup pages can surface a lot of candidate nodes.
  const owningKeys = await Promise.all(
    nodes.map((node) =>
      node.type === 'INSTANCE' ? getInstanceOwningKey(node) : node.type === 'COMPONENT_SET' ? Promise.resolve({ key: node.key, name: node.name }) : getOwningKey(node)
    )
  );
  const groups = new Map<string, CandidateInfo>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const owning = owningKeys[i];
    // Private nested sub-components use a "Parent / part" naming convention
    // (e.g. "_gravity-list-entry-new / leading"), which also contains
    // "list-entry" and would otherwise show up as a false candidate here —
    // only the real top-level component has no "/" in its name.
    if (!owning || !/list-entry/i.test(owning.name) || owning.name.includes('/')) continue;
    const existing = groups.get(owning.key);
    if (existing) {
      existing.count += 1;
    } else {
      const page = findPageOf(node);
      groups.set(owning.key, {
        key: owning.key,
        name: owning.name,
        count: 1,
        exampleNodeId: node.id,
        pageName: page?.name ?? '',
        role: detectReferenceRoleFromName(owning.name),
      });
    }
  }
  return Array.from(groups.values());
}

// ---------------------------------------------------------------------------
// Snapshotting — capture everything before any mutation (safety contract
// rule 10: nested state must be read before the main component swap).
// ---------------------------------------------------------------------------

async function readLeadingSnapshot(instance: InstanceNode): Promise<LeadingSnapshot | null> {
  const leadingWrap = findChildByStructuralName(instance, 'leading');
  if (!leadingWrap) return null;
  const leadingInstance = findDescendantInstance(leadingWrap);
  if (!leadingInstance) return null;

  const typeProp = findProp(leadingInstance, 'type');
  const type = typeProp ? (String(typeProp.value).toLowerCase() as LeadingType) : null;

  if (type === 'image') {
    const img = findChildByName(leadingInstance, 'image');
    return { type: 'image', imageFills: fillsSnapshot(img) };
  }
  if (type === 'icon') {
    const iconNameProp = findProp(leadingInstance, 'icon-name');
    const iconName = iconNameProp ? String(iconNameProp.value) : undefined;
    return { type: 'icon', iconName, iconIsDefault: !iconName || iconName === 'gravity-icon-bull' };
  }
  if (type === 'avatar') {
    const initialsProp = findProp(leadingInstance, 'initials');
    const pictureProp = findProp(leadingInstance, 'picture');
    const pictureNode = findChildByName(leadingInstance, 'gravity-avatar') || leadingInstance;
    const pictureRect = findAvatarPicture(pictureNode);
    return {
      type: 'avatar',
      avatarInitials: initialsProp ? String(initialsProp.value) : undefined,
      avatarPicture: pictureProp ? Boolean(pictureProp.value) : undefined,
      avatarPictureFill: fillsSnapshot(pictureRect),
    };
  }
  if (type === 'flag') {
    const countryProp = findProp(leadingInstance, 'country-name');
    const codeProp = findProp(leadingInstance, 'code');
    return {
      type: 'flag',
      flagCountryName: countryProp ? String(countryProp.value) : undefined,
      flagCode: codeProp ? String(codeProp.value) : undefined,
    };
  }
  return { type: 'unknown' };
}

function readActionSnapshot(instance: InstanceNode, hasAction: boolean): ActionSnapshot {
  if (!hasAction) return { present: false };
  const actionContainer = findChildByName(instance, 'action-container');
  const actionInstance = actionContainer ? findDescendantInstance(actionContainer) : findDescendantInstance(instance);
  if (!actionInstance) return { present: false };
  const labelProp = findProp(actionInstance, 'label');
  const iconNameProp = findProp(actionInstance, 'icon-name');
  const iconPositionProp = findProp(actionInstance, '~ icon-position');
  return {
    present: true,
    label: labelProp ? String(labelProp.value) : undefined,
    iconName: iconNameProp ? String(iconNameProp.value) : undefined,
    iconPosition: iconPositionProp ? String(iconPositionProp.value) : undefined,
  };
}

function childNameList(node: SceneNode): string {
  if (!('children' in node)) return '(no children)';
  const names = (node as ChildrenMixin).children.map((c) => `${c.name} [${c.type}]`);
  return names.length > 0 ? names.join(', ') : '(empty)';
}

async function readMetaInfo(instance: InstanceNode): Promise<{ metaSlotInstance: InstanceNode | null; metaDiagnostic: string | null }> {
  // Meta is an instance-swap property, like leading — the target component
  // must be reapplied via swapComponent(), never by cloning/appending a node
  // into the tree: Figma structurally locks the internals of an instance,
  // so appendChild() inside one always throws "Cannot move node."
  //
  // Carry the live INSTANCE reference straight through from audit to
  // migration (not just its main component) — do NOT round-trip through a
  // key. swapComponent() alone only changes which component is displayed;
  // it does not carry over THIS instance's own overrides (e.g. a status
  // badge's slotted label text and color), so the source instance itself
  // must still be available at migration time to copy those overrides from.
  const metaContainer = findMetaContainer(instance);
  if (!metaContainer || !('children' in metaContainer)) {
    return {
      metaSlotInstance: null,
      metaDiagnostic: `no meta-container found — top-level children: ${childNameList(instance)}`,
    };
  }
  // Not name-matched: once a consumer picks real meta content, that
  // instance keeps ITS OWN layer name (e.g. "status-badge"), not the
  // generic "meta-slot"/"meta" placeholder name — so the only reliable
  // signal is "the instance living inside meta-container", whatever it's
  // called.
  const metaSlot = findDescendantInstance(metaContainer);
  if (!metaSlot) {
    return {
      metaSlotInstance: null,
      metaDiagnostic: `meta-container "${metaContainer.name}" found, but no instance inside it at all — its children: ${childNameList(metaContainer)}`,
    };
  }
  return { metaSlotInstance: metaSlot, metaDiagnostic: null };
}

async function auditInstance(instance: InstanceNode): Promise<InstanceSnapshot> {
  const page = instance.parent ? findPageOf(instance) : figma.currentPage;
  const parent = instance.parent;
  const siblingIndex = parent && 'children' in parent ? (parent as ChildrenMixin).children.indexOf(instance) : -1;

  const vp = instance.variantProperties || {};
  const readVariant = (base: string): string | null => {
    const key = Object.keys(vp).find((k) => normalizeBase(k) === normalizeBase(base));
    return key ? vp[key] : null;
  };
  const readVariantBool = (base: string): boolean => readVariant(base) === 'true' || readVariant(base) === 'True';

  const variant: VariantSnapshot = {
    width: readVariant('~ width'),
    type: readVariant('type'),
    presentational: readVariantBool('presentational'),
    state: readVariant('~ state'),
    selected: readVariantBool('selected'),
    action: readVariantBool('action'),
  };

  const headingProp = findProp(instance, 'title');
  const descriptionProp = findProp(instance, 'description');

  const leadingBoolProp = findProp(instance, '~ leading');
  const descriptionBoolProp = findProp(instance, '~ description');
  const focusBoolProp = findProp(instance, '~ focus');
  const switchesContextProp = findPropAny(instance, ['switchesContext', 'switches-context']);
  const metaBoolProp = findProp(instance, '~ meta');
  const persistentProp = findProp(instance, 'persistent');

  // If ~leading is explicitly false, the leading isn't shown at all — its
  // internal type doesn't matter and must not be resolved/enforced (that's
  // what was blocking migration on rows with a hidden, unresolvable type).
  const leading = leadingBoolProp && leadingBoolProp.value === false ? null : await readLeadingSnapshot(instance);
  const action = readActionSnapshot(instance, variant.action);
  const meta = await readMetaInfo(instance);

  return {
    nodeId: instance.id,
    pageId: page?.id ?? '',
    pageName: page?.name ?? '',
    parentId: parent?.id ?? '',
    siblingIndex,
    x: instance.x,
    y: instance.y,
    width: instance.width,
    height: instance.height,
    rotation: instance.rotation,
    visible: instance.visible,
    opacity: instance.opacity,
    blendMode: instance.blendMode,
    layoutAlign: 'layoutAlign' in instance ? (instance as unknown as { layoutAlign: string }).layoutAlign : undefined,
    layoutPositioning:
      'layoutPositioning' in instance ? (instance as unknown as { layoutPositioning: string }).layoutPositioning : undefined,
    constraints: 'constraints' in instance ? (instance as unknown as ConstraintMixin).constraints : undefined,
    reactions: 'reactions' in instance ? JSON.parse(JSON.stringify((instance as unknown as { reactions: unknown }).reactions)) : undefined,
    variant,
    heading: headingProp ? String(headingProp.value) : null,
    description: descriptionProp ? String(descriptionProp.value) : null,
    bool: {
      leading: leadingBoolProp ? Boolean(leadingBoolProp.value) : null,
      description: descriptionBoolProp ? Boolean(descriptionBoolProp.value) : null,
      focus: focusBoolProp ? Boolean(focusBoolProp.value) : null,
      switchesContext: switchesContextProp ? Boolean(switchesContextProp.value) : null,
      meta: metaBoolProp ? Boolean(metaBoolProp.value) : null,
      persistent: persistentProp ? Boolean(persistentProp.value) : null,
    },
    leading,
    action,
    metaSlotInstance: meta.metaSlotInstance,
    metaDiagnostic: meta.metaDiagnostic,
  };
}

function findPageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === 'PAGE') return current as PageNode;
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pre-migration gate
// ---------------------------------------------------------------------------

function gateCheck(snapshots: InstanceSnapshot[], res: Resolution): { ok: boolean; missingLeadingTypes: LeadingType[]; needsAction: boolean; actionMissing: boolean } {
  const neededTypes = new Set<LeadingType>();
  for (const s of snapshots) {
    if (s.leading && s.leading.type !== 'unknown') neededTypes.add(s.leading.type as LeadingType);
  }
  const missingLeadingTypes = Array.from(neededTypes).filter((t) => !res.newLeadingTypeKeys[t]);
  const needsAction = snapshots.some((s) => s.variant.action);
  const actionMissing = needsAction && !res.newActionKey;
  const ok = missingLeadingTypes.length === 0 && !actionMissing;
  return { ok, missingLeadingTypes, needsAction, actionMissing };
}

// ---------------------------------------------------------------------------
// Migration mapping tables
// ---------------------------------------------------------------------------

const WIDTH_TO_SIZE: Record<string, string> = { '≥480px': 'medium', '<480px': 'small' };
const TYPE_MAP: Record<string, string> = { bare: 'bare', box: 'boxed' };
const STATE_MAP: Record<string, string> = { initial: 'initial', hover: 'hover', active: 'hover' };

function setPropByBase(instance: InstanceNode, base: string, value: string | boolean): boolean {
  const props = instance.componentProperties || {};
  const target = normalizeBase(base);
  for (const key of Object.keys(props)) {
    if (normalizeBase(key.split('#')[0]) === target) {
      try {
        instance.setProperties({ [key]: value as string | boolean });
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-instance migration
// ---------------------------------------------------------------------------

// True if `node` (or any ancestor up to the page) is itself an INSTANCE —
// meaning it sits inside another component's structurally locked internals.
// Figma forbids insertChild()/remove() there; the only legal mutation is
// swapComponent() on the node that's already present.
function isInsideLockedInstance(node: BaseNode): boolean {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === 'INSTANCE') return true;
    if (current.type === 'PAGE') return false;
    current = current.parent;
  }
  return false;
}

// All variant/text/boolean/leading/action/meta mapping — shared by both the
// create-and-replace path (top-level instances) and the swap-in-place path
// (instances nested inside another instance, where insertChild/remove are
// impossible). Throws on any unrecoverable mapping failure.
// Every directly overridable visual/layout/text property a consumer can set
// on a node inside a slotted instance. Values that are figma.mixed are skipped.
// Order matters for TEXT nodes: fontName must land before size/spacing.
const STYLE_KEYS = [
  'fontName',
  'fontSize',
  'textCase',
  'textDecoration',
  'letterSpacing',
  'lineHeight',
  'textAlignHorizontal',
  'textAlignVertical',
  'textAutoResize',
  'paragraphSpacing',
  'paragraphIndent',
  'opacity',
  'blendMode',
  'effects',
  'strokeWeight',
  'strokeAlign',
  'strokeCap',
  'strokeJoin',
  'dashPattern',
  'cornerRadius',
  'topLeftRadius',
  'topRightRadius',
  'bottomLeftRadius',
  'bottomRightRadius',
  'cornerSmoothing',
  'rotation',
  'layoutAlign',
  'layoutGrow',
  'layoutPositioning',
  'clipsContent',
  'constraints',
  'isMask',
] as const;

interface NodeStyleOverride {
  path: number[];
  name: string;
  fills?: Paint[];
  strokes?: Paint[];
  fillStyleId?: string;
  strokeStyleId?: string;
  effectStyleId?: string;
  textStyleId?: string;
  reactions?: unknown;
  scalars: Record<string, unknown>;
}

interface OverrideCapture {
  main: ComponentNode;
  props: Record<string, string | boolean>;
  instanceProps: { path: number[]; props: Record<string, string | boolean> }[];
  texts: { path: number[]; characters: string }[];
  visibility: { path: number[]; visible: boolean }[];
  styles: NodeStyleOverride[];
}

function paintsSnapshot(node: SceneNode, kind: 'fills' | 'strokes'): Paint[] | undefined {
  if (!(kind in node)) return undefined;
  const value = (node as unknown as Record<string, unknown>)[kind];
  if (value === figma.mixed || !Array.isArray(value)) return undefined;
  return (value as Paint[]).map((p) => JSON.parse(JSON.stringify(p)));
}

function styleIdSnapshot(node: SceneNode, key: string): string | undefined {
  if (!(key in node)) return undefined;
  const v = (node as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function readNodeStyle(node: SceneNode, path: number[]): NodeStyleOverride {
  const raw = node as unknown as Record<string, unknown>;
  const scalars: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    if (!(key in node)) continue;
    const v = raw[key];
    if (v === figma.mixed || v === undefined) continue;
    scalars[key] = JSON.parse(JSON.stringify(v));
  }
  return {
    path,
    name: node.name,
    fills: paintsSnapshot(node, 'fills'),
    strokes: paintsSnapshot(node, 'strokes'),
    fillStyleId: styleIdSnapshot(node, 'fillStyleId'),
    strokeStyleId: styleIdSnapshot(node, 'strokeStyleId'),
    effectStyleId: styleIdSnapshot(node, 'effectStyleId'),
    textStyleId: styleIdSnapshot(node, 'textStyleId'),
    reactions: 'reactions' in node && raw.reactions !== undefined ? JSON.parse(JSON.stringify(raw.reactions)) : undefined,
    scalars,
  };
}

// Newer Figma APIs expose async setters for style ids / reactions; older
// typings only have the plain property. Use whichever exists.
async function setViaAsyncOrAssign(node: SceneNode, asyncName: string, propName: string, value: unknown): Promise<void> {
  const raw = node as unknown as Record<string, unknown>;
  const fn = raw[asyncName];
  if (typeof fn === 'function') {
    await (fn as (v: unknown) => Promise<void>).call(node, value);
  } else {
    raw[propName] = value;
  }
}

async function applyNodeStyle(targetNode: SceneNode, o: NodeStyleOverride, warnings: string[]): Promise<void> {
  const label = `meta node [${o.path.join(',')}] "${o.name}"`;
  const raw = targetNode as unknown as Record<string, unknown>;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const step = async (what: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      warnings.push(`${label} ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (targetNode.name !== o.name) await step('name', () => void (targetNode.name = o.name));

  if (targetNode.type === 'TEXT') {
    const t = targetNode as TextNode;
    await step('font load', async () => {
      if (t.fontName !== figma.mixed) await figma.loadFontAsync(t.fontName as FontName);
      if (o.scalars.fontName) await figma.loadFontAsync(o.scalars.fontName as FontName);
    });
  }

  for (const key of STYLE_KEYS) {
    if (!(key in o.scalars) || !(key in targetNode)) continue;
    if (same(raw[key], o.scalars[key])) continue;
    await step(key, () => void (raw[key] = o.scalars[key]));
  }

  // A linked style wins over raw paints: restoring the style id keeps the
  // link, whereas writing raw paints would detach it. Raw paints are only
  // written when the source had no style link at all.
  if (o.fillStyleId !== undefined && 'fillStyleId' in targetNode && raw.fillStyleId !== o.fillStyleId) {
    await step('fillStyleId', () => setViaAsyncOrAssign(targetNode, 'setFillStyleIdAsync', 'fillStyleId', o.fillStyleId));
  }
  if (!o.fillStyleId && o.fills && 'fills' in targetNode && !same(paintsSnapshot(targetNode, 'fills'), o.fills)) {
    await step('fills', () => void ((targetNode as GeometryMixin).fills = o.fills!));
  }
  if (o.strokeStyleId !== undefined && 'strokeStyleId' in targetNode && raw.strokeStyleId !== o.strokeStyleId) {
    await step('strokeStyleId', () => setViaAsyncOrAssign(targetNode, 'setStrokeStyleIdAsync', 'strokeStyleId', o.strokeStyleId));
  }
  if (!o.strokeStyleId && o.strokes && 'strokes' in targetNode && !same(paintsSnapshot(targetNode, 'strokes'), o.strokes)) {
    await step('strokes', () => void ((targetNode as GeometryMixin).strokes = o.strokes!));
  }
  if (o.effectStyleId !== undefined && 'effectStyleId' in targetNode && raw.effectStyleId !== o.effectStyleId) {
    await step('effectStyleId', () => setViaAsyncOrAssign(targetNode, 'setEffectStyleIdAsync', 'effectStyleId', o.effectStyleId));
  }
  if (o.textStyleId !== undefined && targetNode.type === 'TEXT' && raw.textStyleId !== o.textStyleId) {
    await step('textStyleId', () => setViaAsyncOrAssign(targetNode, 'setTextStyleIdAsync', 'textStyleId', o.textStyleId));
  }
  if (o.reactions !== undefined && 'reactions' in targetNode && !same(raw.reactions, o.reactions)) {
    await step('reactions', () => setViaAsyncOrAssign(targetNode, 'setReactionsAsync', 'reactions', o.reactions));
  }
}

// Index-based (not name-based) child lookup — siblings that are instances
// of the same component (e.g. two status badges) get the same default
// layer name from Figma, so name-based paths collide and silently overwrite
// each other. Position is unambiguous when target is guaranteed to be the
// exact same component as source (which it always is here, post-swap).
function findChildByIndexPath(node: SceneNode, path: number[]): SceneNode | null {
  let current: SceneNode | null = node;
  for (const idx of path) {
    if (!current || !('children' in current)) return null;
    const child = (current as ChildrenMixin).children[idx] as SceneNode | undefined;
    if (!child) return null;
    current = child;
  }
  return current;
}

// Pure read — captures everything needed to reproduce `source`'s overrides
// elsewhere, with no dependency on any target. Split out from the "apply"
// half so callers can capture BEFORE a swapComponent() that would destroy
// `source`'s own children (the nested/locked-instance migration path calls
// swapComponent() on the very node this data lives inside, before this data
// would otherwise be read — capturing first avoids reading a deleted node).
async function captureOverrides(source: InstanceNode): Promise<OverrideCapture | null> {
  const main = await source.getMainComponentAsync();
  if (!main) return null;

  const readProps = (inst: InstanceNode): Record<string, string | boolean> => {
    const out: Record<string, string | boolean> = {};
    const p = inst.componentProperties || {};
    for (const key of Object.keys(p)) out[key] = p[key].value as string | boolean;
    return out;
  };

  const props = readProps(source);

  // Every NESTED instance carries its own property overrides too (e.g. a
  // status badge slotted in here set to grey when its component defaults to
  // green). swapComponent() resets those to the component defaults, and
  // capturing only the root's componentProperties silently loses them — the
  // badge comes back in the wrong variant. Capture each descendant
  // instance's own properties as well, keyed by index path.
  function collectInstanceProps(
    node: SceneNode,
    path: number[],
    out: { path: number[]; props: Record<string, string | boolean> }[]
  ): void {
    if (path.length > 0 && node.type === 'INSTANCE') {
      out.push({ path: [...path], props: readProps(node as InstanceNode) });
    }
    if ('children' in node) {
      (node as ChildrenMixin).children.forEach((child, idx) => collectInstanceProps(child as SceneNode, [...path, idx], out));
    }
  }
  const instanceProps: { path: number[]; props: Record<string, string | boolean> }[] = [];
  collectInstanceProps(source, [], instanceProps);

  function collectText(node: SceneNode, path: number[], out: { path: number[]; characters: string }[]): void {
    if (node.type === 'TEXT') out.push({ path: [...path], characters: (node as TextNode).characters });
    if ('children' in node) {
      (node as ChildrenMixin).children.forEach((child, idx) => collectText(child as SceneNode, [...path, idx], out));
    }
  }
  const texts: { path: number[]; characters: string }[] = [];
  collectText(source, [], texts);

  // swapComponent() resets every descendant to the target component's own
  // defaults, including plain visible=false overrides that aren't a
  // component property at all (e.g. a hidden utility/documentation element
  // baked into a shared meta template) — those are otherwise silently lost
  // and reappear after the swap. Capture every descendant's visibility so
  // it can be restored verbatim, not just component properties and text.
  function collectVisibility(node: SceneNode, path: number[], out: { path: number[]; visible: boolean }[]): void {
    out.push({ path: [...path], visible: node.visible });
    if ('children' in node) {
      (node as ChildrenMixin).children.forEach((child, idx) => collectVisibility(child as SceneNode, [...path, idx], out));
    }
  }
  const visibility: { path: number[]; visible: boolean }[] = [];
  source.children.forEach((child, idx) => collectVisibility(child as SceneNode, [idx], visibility));

  // None of the above covers plain visual overrides — a status dot whose
  // fill was recolored, an icon's vector tinted orange, a renamed layer, a
  // detached text style. swapComponent() resets all of them to the
  // component defaults. Capture the full style surface of every node
  // (root included) so it can be restored verbatim.
  function collectStyles(node: SceneNode, path: number[], out: NodeStyleOverride[]): void {
    out.push(readNodeStyle(node, path));
    if ('children' in node) {
      (node as ChildrenMixin).children.forEach((child, idx) => collectStyles(child as SceneNode, [...path, idx], out));
    }
  }
  const styles: NodeStyleOverride[] = [];
  collectStyles(source, [], styles);

  return { main, props, instanceProps, texts, visibility, styles };
}

// Swaps `target` to the captured component, then reapplies the captured
// component-property and text overrides onto it — swapComponent() alone
// only changes WHICH component is displayed, e.g. a status badge's own
// slotted label text and color are not carried over automatically.
// Returns human-readable warnings for every override that did not stick.
async function applyOverrideCapture(target: InstanceNode, captured: OverrideCapture): Promise<string[]> {
  const warnings: string[] = [];
  target.swapComponent(captured.main);

  const applyProps = (inst: InstanceNode, props: Record<string, string | boolean>, label: string) => {
    for (const key of Object.keys(props)) {
      try {
        inst.setProperties({ [key]: props[key] });
      } catch (err) {
        warnings.push(`${label} "${key}" → ${String(props[key])}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  applyProps(target, captured.props, 'meta root prop');

  // Shallowest-first: setting a variant property rebuilds that node's own
  // subtree, discarding anything already written deeper inside it. Applying
  // outer instances before inner ones means each one is rebuilt before its
  // children are restored, not after. Text and visibility are reapplied
  // after all of these for the same reason.
  const nested = [...captured.instanceProps].sort((a, b) => a.path.length - b.path.length);
  for (const { path, props } of nested) {
    const targetNode = findChildByIndexPath(target, path);
    if (!targetNode || targetNode.type !== 'INSTANCE') {
      warnings.push(`meta nested instance at [${path.join(',')}] not found post-swap — its ${Object.keys(props).length} prop(s) dropped`);
      continue;
    }
    applyProps(targetNode as InstanceNode, props, `meta nested [${path.join(',')}] prop`);
  }

  for (const { path, characters } of captured.texts) {
    const targetNode = findChildByIndexPath(target, path);
    if (!targetNode || targetNode.type !== 'TEXT') continue;
    try {
      const font = (targetNode as TextNode).fontName;
      if (font !== figma.mixed) await figma.loadFontAsync(font as FontName);
      (targetNode as TextNode).characters = characters;
    } catch {
      // mixed/unavailable font or non-editable text — skip this override
    }
  }

  for (const { path, visible } of captured.visibility) {
    const targetNode = findChildByIndexPath(target, path);
    if (targetNode) targetNode.visible = visible;
  }

  // Styles last, root-first (captured in DFS preorder), only where the
  // post-swap default differs from the source — untouched nodes and their
  // variable bindings stay exactly as the component defines them.
  for (const o of captured.styles) {
    const targetNode = findChildByIndexPath(target, o.path);
    if (!targetNode) {
      warnings.push(`meta node [${o.path.join(',')}] "${o.name}" missing post-swap — its style overrides dropped`);
      continue;
    }
    await applyNodeStyle(targetNode, o, warnings);
  }

  // Verify: re-read root + nested props and report anything that silently
  // reverted (setProperties can succeed without throwing yet not persist).
  const verify = (inst: InstanceNode, expected: Record<string, string | boolean>, label: string) => {
    const actual = inst.componentProperties || {};
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) continue;
      if (String(actual[key].value) !== String(expected[key])) {
        warnings.push(`${label} "${key}" expected ${String(expected[key])}, is ${String(actual[key].value)}`);
      }
    }
  };
  verify(target, captured.props, 'meta root prop');
  for (const { path, props } of nested) {
    const node = findChildByIndexPath(target, path);
    if (node && node.type === 'INSTANCE') verify(node as InstanceNode, props, `meta nested [${path.join(',')}] prop`);
  }

  return warnings;
}

async function applyMappings(
  target: InstanceNode,
  snapshot: InstanceSnapshot,
  res: Resolution,
  preCapturedMeta?: OverrideCapture | null
): Promise<string[]> {
  // Collects failures that must surface as manual-review rather than fail
  // silently — e.g. a leading image fill that didn't apply because the
  // expected child name wasn't found. Previously nothing pushed here except
  // the meta path (merged in below), so a silent leading failure reported
  // as a clean "migrated" even though the new instance kept its default
  // content.
  const warnings: string[] = [];

  // Variant mapping
  if (snapshot.variant.width) setPropByBase(target, 'size', WIDTH_TO_SIZE[snapshot.variant.width] ?? snapshot.variant.width);
  if (snapshot.variant.type) setPropByBase(target, 'type', TYPE_MAP[snapshot.variant.type] ?? snapshot.variant.type);
  setPropByBase(target, 'presentational', snapshot.variant.presentational);
  if (snapshot.variant.state) {
    // Confirmed state-combination rule: presentational=true has no
    // hover/active variant in the new component at all, so it must always
    // collapse to initial — this is not just a policy choice, the target
    // combination structurally doesn't exist otherwise.
    const mappedState =
      snapshot.variant.presentational && (snapshot.variant.state === 'hover' || snapshot.variant.state === 'active')
        ? 'initial'
        : STATE_MAP[snapshot.variant.state] ?? snapshot.variant.state;
    setPropByBase(target, '~ state', mappedState);
  }
  setPropByBase(target, 'selected', snapshot.variant.selected);
  setPropByBase(target, '~ actions', snapshot.variant.action);

  // Booleans with no old equivalent — explicit hidden/default per spec.
  setPropByBase(target, '~ meta-bottom', false);
  setPropByBase(target, '~ actions-overflow', false);
  setPropByBase(target, '~ status', false);

  if (snapshot.bool.leading !== null) setPropByBase(target, '~ leading', snapshot.bool.leading);
  if (snapshot.bool.description !== null) setPropByBase(target, '~ description', snapshot.bool.description);
  if (snapshot.bool.focus !== null) setPropByBase(target, '~ focus', snapshot.bool.focus);
  if (snapshot.bool.switchesContext !== null) setPropByBase(target, 'navigational', snapshot.bool.switchesContext);
  if (snapshot.bool.meta !== null) setPropByBase(target, '~ meta', snapshot.bool.meta);
  if (snapshot.bool.persistent !== null) setPropByBase(target, 'actions-persistent', snapshot.bool.persistent);

  // Text
  if (snapshot.heading !== null) setPropByBase(target, 'heading', snapshot.heading);
  if (snapshot.description !== null) setPropByBase(target, 'description', snapshot.description);

  // Leading — switch type via setProperties, never via import/swapComponent.
  // The leading is a private nested component (per spec) that cannot be
  // resolved by key at all, locally or via library import — the only
  // reliable way to reach a specific type is to set the property directly
  // on the leading instance that already exists inside `target`.
  if (snapshot.leading && snapshot.leading.type !== 'unknown') {
    const leadingWrap = findChildByStructuralName(target, 'leading');
    const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
    if (!leadingInstance) {
      throw new Error('New leading instance not found after main component swap.');
    }

    // The main-component swap does NOT guarantee this nested leading is
    // already on the new leading component — it can still default to the
    // OLD leading. A "type" value match (e.g. both happen to have
    // type=icon) is not proof of identity, since old and new leading sets
    // can share the same enum values.
    //
    // Check at the SET level first: if the leading is already on the
    // confirmed-correct set, switching to a different sibling variant is
    // just setProperties() below — no import needed. Only fall back to
    // resolving the specific variant by key (which requires importing a
    // private component, and can fail for any variant that isn't already
    // the one a fresh instance happens to default to) when the leading is
    // genuinely still on a different set entirely.
    const requiredLeading = res.newLeadingTypeKeys[snapshot.leading.type as LeadingType];
    if (!requiredLeading) throw new Error(`No resolved new leading component for type "${snapshot.leading.type}".`);
    const currentOwningSet = await getInstanceOwningKey(leadingInstance);
    const onCorrectSet = res.newLeadingSetKey !== null && currentOwningSet?.key === res.newLeadingSetKey;
    if (!onCorrectSet) {
      const correctComponent = await resolveComponentByKey(requiredLeading.key);
      leadingInstance.swapComponent(correctComponent.type === 'COMPONENT_SET' ? correctComponent.defaultVariant : correctComponent);
    }

    const typeProp = findProp(leadingInstance, 'type');
    if (!typeProp) throw new Error('New leading instance has no "type" property to switch.');
    leadingInstance.setProperties({ [typeProp.key]: snapshot.leading.type });
    const confirmProp = findProp(leadingInstance, 'type');
    if (!confirmProp || String(confirmProp.value).toLowerCase() !== snapshot.leading.type) {
      throw new Error(`Could not switch the new leading to type "${snapshot.leading.type}".`);
    }
    const finalKey = await getInstanceComponentKey(leadingInstance);
    if (finalKey !== requiredLeading.key) {
      throw new Error('Leading is still not on the new leading component after corrective swap.');
    }

    // Unconditional final check, independent of the comparison above: if
    // the captured "required" key was itself wrong (e.g. resolution
    // mistakenly captured the old leading as if it were new), the checks
    // above would pass — currentKey/finalKey would "match" a wrong value
    // and never trigger a swap. This catches that regardless of why —
    // never silently succeed with a leading still on the old set.
    if (res.oldLeadingSetKey) {
      const finalOwning = await getInstanceOwningKey(leadingInstance);
      if (finalOwning && finalOwning.key === res.oldLeadingSetKey) {
        throw new Error(
          'Leading resolved to the OLD leading set despite matching the captured key — the captured leading data is wrong. Re-run "Capture selection as LEADING SET" pointing at a confirmed-correct leading.'
        );
      }
    }

    if (snapshot.leading.type === 'image') {
      const img = findChildByName(leadingInstance, 'image');
      const imgInner = img ? findChildByName(img, 'image') : null;
      const fillTarget = imgInner ?? img;
      if (!snapshot.leading.imageFills) {
        warnings.push(
          `leading image: no fill was captured from the source instance (source "image" child was missing or its fills could not be read) — new instance kept its default image`
        );
      } else if (!fillTarget) {
        warnings.push(
          `leading image: new leading's "image" child not found after swap — new instance kept its default image. Leading's children: ${childNameList(leadingInstance)}`
        );
      } else if (!('fills' in fillTarget)) {
        warnings.push(`leading image: found "${fillTarget.name}" but it has no fills property — new instance kept its default image`);
      } else {
        (fillTarget as GeometryMixin).fills = snapshot.leading.imageFills;
        // swapComponent()/setProperties() can silently no-op a fills write in edge
        // cases (e.g. the node is fill-locked or bound to a variable) — verify it
        // actually landed rather than trusting the assignment succeeded.
        const after = fillsSnapshot(fillTarget);
        if (JSON.stringify(after) !== JSON.stringify(snapshot.leading.imageFills)) {
          warnings.push(`leading image: fill was set on "${fillTarget.name}" but didn't stick — new instance may still show its default image`);
        }
      }
    } else if (snapshot.leading.type === 'icon') {
      if (!snapshot.leading.iconIsDefault && snapshot.leading.iconName) {
        setPropByBase(leadingInstance, 'icon-name', snapshot.leading.iconName);
      }
    } else if (snapshot.leading.type === 'avatar') {
      if (snapshot.leading.avatarInitials !== undefined) setPropByBase(leadingInstance, 'initials', snapshot.leading.avatarInitials);
      if (snapshot.leading.avatarPicture !== undefined) setPropByBase(leadingInstance, 'picture', snapshot.leading.avatarPicture);
      const avatarNode = findChildByName(leadingInstance, 'avatar') || leadingInstance;
      const pictureRect = findAvatarPicture(avatarNode);
      // Same silent-failure class as the leading-image branch above: if the
      // picture fill can't be captured, found, or doesn't stick, the new
      // instance keeps its default avatar photo with zero signal that it
      // happened. Confirmed in practice — multiple avatar rows all ended up
      // showing the same default picture after a "successful" migration.
      if (!snapshot.leading.avatarPictureFill) {
        // No fill was ever captured — this is expected when picture is false
        // (initials-only avatar), so only warn when a picture was actually set.
        if (snapshot.leading.avatarPicture) {
          warnings.push(`leading avatar: no picture fill was captured from the source instance — new instance kept its default picture`);
        }
      } else if (!pictureRect) {
        warnings.push(
          `leading avatar: new leading's "picture" node not found after swap — new instance kept its default picture. Avatar's children: ${childNameList(avatarNode)}`
        );
      } else if (!('fills' in pictureRect)) {
        warnings.push(`leading avatar: found "${pictureRect.name}" but it has no fills property — new instance kept its default picture`);
      } else {
        (pictureRect as GeometryMixin).fills = snapshot.leading.avatarPictureFill;
        const after = fillsSnapshot(pictureRect);
        if (JSON.stringify(after) !== JSON.stringify(snapshot.leading.avatarPictureFill)) {
          warnings.push(`leading avatar: fill was set on "${pictureRect.name}" but didn't stick — new instance may still show its default picture`);
        }
      }
    } else if (snapshot.leading.type === 'flag') {
      if (snapshot.leading.flagCountryName !== undefined) setPropByBase(leadingInstance, 'country-name', snapshot.leading.flagCountryName);
      if (snapshot.leading.flagCode !== undefined) setPropByBase(leadingInstance, 'code', snapshot.leading.flagCode);
    }
  }

  // Action — copy onto the first action slot only.
  if (snapshot.action.present) {
    const actionsFrame = findActionsFrame(target);
    const firstAction =
      actionsFrame && 'children' in actionsFrame
        ? ((actionsFrame as ChildrenMixin).children.find((c) => c.type === 'INSTANCE' && /^action$/i.test(c.name)) as InstanceNode | undefined)
        : undefined;
    if (firstAction) {
      if (snapshot.action.label !== undefined) setPropByBase(firstAction, 'label', snapshot.action.label);
      if (snapshot.action.iconName !== undefined) setPropByBase(firstAction, 'icon-name', snapshot.action.iconName);
      if (snapshot.action.iconPosition !== undefined) setPropByBase(firstAction, '~ icon-position', snapshot.action.iconPosition);
    }
  }

  // Meta — an instance-swap property, like leading. Reapply via
  // swapComponent() on the new instance's own meta slot, then copy over the
  // source meta instance's own overrides (root props, every nested
  // instance's props, text, visibility). Never clone/append a node — Figma
  // structurally forbids that inside an instance's tree.
  if (snapshot.bool.meta === true && !snapshot.metaSlotInstance && !preCapturedMeta) {
    throw new Error(
      `Instance has meta enabled but its meta slot content could not be read — refusing to migrate and silently reset it. ${snapshot.metaDiagnostic ?? ''}`
    );
  }
  if (snapshot.metaSlotInstance || preCapturedMeta) {
    const newMetaContainer = findMetaContainer(target);
    const newMetaSlot = newMetaContainer ? findDescendantInstance(newMetaContainer) : null;
    if (!newMetaSlot) {
      throw new Error(
        `Could not preserve meta content — no instance found inside the new instance's meta-container. ${
          newMetaContainer ? `Its children: ${childNameList(newMetaContainer)}` : 'meta-container itself not found.'
        }`
      );
    }
    const captured = preCapturedMeta ?? (await captureOverrides(snapshot.metaSlotInstance!));
    if (!captured) throw new Error("Could not read the meta slot's current component.");
    warnings.push(...(await applyOverrideCapture(newMetaSlot, captured)));
  }
  return warnings;
}

async function migrateInstance(snapshot: InstanceSnapshot, res: Resolution): Promise<OutcomeRow> {
  if (snapshot.leading && snapshot.leading.type !== 'unknown' && !res.newLeadingTypeKeys[snapshot.leading.type as LeadingType]) {
    return {
      sourceNodeId: snapshot.nodeId,
      status: 'skipped',
      reason: `Required leading type "${snapshot.leading.type}" could not be resolved on the new component — never falling back to a different type.`,
    };
  }
  if (snapshot.variant.action && !res.newActionKey) {
    return { sourceNodeId: snapshot.nodeId, status: 'skipped', reason: 'Instance has an action but the new action component could not be resolved.' };
  }

  const source = await figma.getNodeByIdAsync(snapshot.nodeId);
  if (!source || source.type !== 'INSTANCE') {
    return { sourceNodeId: snapshot.nodeId, status: 'failed', reason: 'Source node no longer exists or is not an instance.' };
  }
  const sourceInstance = source as InstanceNode;
  const parent = sourceInstance.parent;
  if (!parent) {
    return { sourceNodeId: snapshot.nodeId, status: 'failed', reason: 'Source node has no parent.' };
  }

  let newMainComponent: ComponentNode | ComponentSetNode;
  try {
    newMainComponent = await resolveComponentByKey(res.newMainKey);
  } catch {
    return {
      sourceNodeId: snapshot.nodeId,
      status: 'failed',
      reason: 'Could not find the new main component in the current file, and it is not resolvable via a published library.',
    };
  }
  const newMainAsComponent = newMainComponent.type === 'COMPONENT_SET' ? newMainComponent.defaultVariant : newMainComponent;

  if (isInsideLockedInstance(parent)) {
    // Nested inside another instance's overrides (e.g. placed as content
    // inside a gravity-panel instance) — insertChild()/remove() are not
    // legal here, so the source instance must be mutated in place instead
    // of replaced. Geometry doesn't need copying since it's the same node.
    const oldMain = await sourceInstance.getMainComponentAsync();
    // Must capture meta's overrides BEFORE swapping sourceInstance's own
    // component below — that swap rebuilds this same node's children,
    // destroying snapshot.metaSlotInstance (a live reference into the tree
    // being rebuilt) before applyMappings would otherwise get to read it.
    const preCapturedMeta = snapshot.metaSlotInstance ? await captureOverrides(snapshot.metaSlotInstance) : null;
    try {
      sourceInstance.swapComponent(newMainAsComponent);
      // swapComponent() on a node slotted into another instance's overrides
      // (e.g. a hidden row inside a gravity-accordion-item's body) can orphan
      // the ANCESTOR's override for this child — Figma tracks that override
      // against the child's pre-swap identity, and the swap changes it.
      // Confirmed failure mode: a hidden (visible: false) row came back
      // visible after migration even though this code never sets visible
      // to true anywhere.
      //
      // Only re-assert `visible` — it's the one confirmed to get orphaned.
      // Do NOT add opacity/rotation/blendMode here: Figma rejects writes to
      // "relative-transform" properties (rotation confirmed) on a node
      // slotted into another instance's auto-layout ("This property cannot
      // be overridden in an instance"), which aborted the whole migration
      // for every such instance. Never set a node property here without
      // confirming Figma actually allows overriding it in this context.
      try {
        sourceInstance.visible = snapshot.visible;
      } catch {
        // Some slotted contexts may reject even this — don't let a defensive
        // re-assertion abort a migration that otherwise would have succeeded.
      }
      const warnings = await applyMappings(sourceInstance, snapshot, res, preCapturedMeta);
      // applyMappings swaps the meta slot too, which is the same kind of
      // nested-override mutation — check visibility survived that as well,
      // and force it back rather than silently trusting it did. When this
      // succeeds it's self-healed and needs no human attention — log it as
      // an informational note, not a manual-review-triggering warning.
      // Only an outright failure to force it back belongs in `warnings`.
      const notes: string[] = [];
      if (sourceInstance.visible !== snapshot.visible) {
        try {
          sourceInstance.visible = snapshot.visible;
          notes.push(`visibility reverted to ${!snapshot.visible} after migration — forced back to ${snapshot.visible} automatically`);
        } catch (err) {
          warnings.push(
            `visibility reverted to ${sourceInstance.visible} after migration (source was ${snapshot.visible}) and could not be forced back: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      const problems = await validateReplacement(sourceInstance, snapshot, res);
      if (problems.length > 0) throw new Error(problems.join('; '));
      return {
        sourceNodeId: snapshot.nodeId,
        replacementNodeId: sourceInstance.id,
        status: warnings.length > 0 ? 'manual-review' : 'migrated',
        reason:
          warnings.length > 0
            ? `Swapped in place, but some overrides did not fully stick: ${warnings.join(' | ')}`
            : notes.length > 0
              ? `Validated and swapped in place. ${notes.join(' | ')}`
              : 'Validated and swapped in place (nested inside another instance — cannot be replaced as a separate node).',
      };
    } catch (err) {
      if (oldMain) {
        try {
          sourceInstance.swapComponent(oldMain);
        } catch {
          // best effort — if this also fails, the reason below still surfaces the original error
        }
      }
      return {
        sourceNodeId: snapshot.nodeId,
        status: 'failed',
        reason: `${err instanceof Error ? err.message : String(err)} — reverted component reference; some property overrides made before the failure may remain changed.`,
      };
    }
  }

  if (!('children' in parent)) {
    return { sourceNodeId: snapshot.nodeId, status: 'failed', reason: 'Source node has no valid parent to insert the replacement into.' };
  }

  // Capture meta's overrides BEFORE the replacement exists: snapshot.metaSlotInstance
  // is a live ref into the source tree and must be read while that tree is intact.
  const preCapturedMetaTopLevel = snapshot.metaSlotInstance ? await captureOverrides(snapshot.metaSlotInstance) : null;

  let replacement: InstanceNode;
  try {
    replacement = newMainAsComponent.createInstance();
  } catch {
    return { sourceNodeId: snapshot.nodeId, status: 'failed', reason: 'Could not create an instance of the new main component.' };
  }

  try {
    (parent as ChildrenMixin & BaseNode).insertChild(snapshot.siblingIndex, replacement);

    replacement.x = snapshot.x;
    replacement.y = snapshot.y;
    replacement.resize(snapshot.width, snapshot.height);
    replacement.rotation = snapshot.rotation;
    replacement.visible = snapshot.visible;
    replacement.opacity = snapshot.opacity;
    replacement.blendMode = snapshot.blendMode;
    if (snapshot.constraints && 'constraints' in replacement) (replacement as unknown as ConstraintMixin).constraints = snapshot.constraints;
    if (snapshot.layoutAlign && 'layoutAlign' in replacement) (replacement as unknown as { layoutAlign: string }).layoutAlign = snapshot.layoutAlign;
    if (snapshot.layoutPositioning && 'layoutPositioning' in replacement)
      (replacement as unknown as { layoutPositioning: string }).layoutPositioning = snapshot.layoutPositioning;

    const warnings = await applyMappings(replacement, snapshot, res, preCapturedMetaTopLevel);

    const problems = await validateReplacement(replacement, snapshot, res);
    if (problems.length > 0) {
      replacement.remove();
      return { sourceNodeId: snapshot.nodeId, status: 'failed', reason: problems.join('; ') };
    }

    sourceInstance.remove();
    return {
      sourceNodeId: snapshot.nodeId,
      replacementNodeId: replacement.id,
      status: warnings.length > 0 ? 'manual-review' : 'migrated',
      reason: warnings.length > 0 ? `Replaced, but some overrides did not fully stick: ${warnings.join(' | ')}` : 'Validated and replaced.',
    };
  } catch (err) {
    replacement.remove();
    return { sourceNodeId: snapshot.nodeId, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function validateReplacement(replacement: InstanceNode, snapshot: InstanceSnapshot, res: Resolution): Promise<string[]> {
  const problems: string[] = [];
  const owning = await getInstanceOwningKey(replacement);
  if (!owning || owning.key !== res.newMainKey) problems.push('Destination main component key does not match the resolved new component.');

  if (snapshot.leading && snapshot.leading.type !== 'unknown') {
    const leadingWrap = findChildByStructuralName(replacement, 'leading');
    const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
    const typeProp = leadingInstance ? findProp(leadingInstance, 'type') : null;
    const actualType = typeProp ? String(typeProp.value).toLowerCase() : null;
    if (actualType !== snapshot.leading.type) {
      problems.push(`Leading type mismatch: expected "${snapshot.leading.type}", got "${actualType}".`);
    }
    // A matching "type" value is not proof of identity — old and new
    // leading component sets can share the same enum values while the
    // leading is still structurally on the OLD component. Check the actual
    // component key.
    const requiredLeading = res.newLeadingTypeKeys[snapshot.leading.type as LeadingType];
    const leadingKey = leadingInstance ? await getInstanceComponentKey(leadingInstance) : null;
    if (requiredLeading && leadingKey !== requiredLeading.key) {
      problems.push('Leading is not on the new leading component (still using the old leading, or an unresolved one).');
    }
  }

  if (snapshot.heading !== null) {
    const headingProp = findProp(replacement, 'heading');
    if (!headingProp || String(headingProp.value) !== snapshot.heading) problems.push('Heading text does not match source.');
  }
  if (snapshot.description !== null) {
    const descProp = findProp(replacement, 'description');
    if (!descProp || String(descProp.value) !== snapshot.description) problems.push('Description text does not match source.');
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildReport(scopeLabel: string, sourceCount: number, outcomes: OutcomeRow[]): string {
  const migrated = outcomes.filter((o) => o.status === 'migrated').length;
  const skipped = outcomes.filter((o) => o.status === 'skipped' || o.status === 'already-migrated').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const manualReview = outcomes.filter((o) => o.status === 'manual-review').length;

  const exceptionLines = outcomes
    .filter((o) => o.status !== 'migrated')
    .map((o) => `- ${o.sourceNodeId}${o.replacementNodeId ? ` / ${o.replacementNodeId}` : ''} — ${o.status} — ${o.reason}`)
    .join('\n');

  return [
    `Scope: ${scopeLabel}`,
    `Source instances: ${sourceCount}`,
    `Migrated: ${migrated}`,
    `Skipped: ${skipped}`,
    `Failed: ${failed}`,
    `Manual review: ${manualReview}`,
    '',
    'Exceptions:',
    exceptionLines || '- none',
  ].join('\n');
}

function scopeLabel(scope: ScopeConfig): string {
  if (scope.mode === 'selection') return 'current selection';
  if (scope.mode === 'current-page') return `page "${figma.currentPage.name}"`;
  if (scope.mode === 'all-pages') return 'all pages';
  return `pages: ${(scope.pageNames || []).join(', ')}`;
}

// ---------------------------------------------------------------------------
// UI message handling
// ---------------------------------------------------------------------------

// Resolves `nodeId` as the old or new reference and merges the result into
// the session resolution. Shared by the explicit "Capture selection" action
// and by the automatic resolve that the scan performs.
async function captureReference(nodeId: string, role: 'old' | 'new'): Promise<void> {
  if (role === 'old') {
    const r = await resolveOldReference(nodeId);
    resolution = {
      oldMainKey: r.mainKey,
      oldMainName: r.mainName,
      newMainKey: resolution?.newMainKey ?? '',
      newMainName: resolution?.newMainName ?? '',
      oldLeadingSetKey: r.leadingSetKey,
      newLeadingTypeKeys: resolution?.newLeadingTypeKeys ?? {},
      newLeadingSetKey: resolution?.newLeadingSetKey ?? null,
      newActionKey: resolution?.newActionKey ?? null,
      diagnostics: r.diagnostics,
    };
    return;
  }

  const r = await resolveNewReference(nodeId, resolution?.oldLeadingSetKey ?? null);
  resolution = {
    oldMainKey: resolution?.oldMainKey ?? '',
    oldMainName: resolution?.oldMainName ?? '',
    newMainKey: r.mainKey,
    newMainName: r.mainName,
    oldLeadingSetKey: resolution?.oldLeadingSetKey ?? null,
    // Merge rather than replace — a verified auto-resolve fills in types
    // this reference confirms, but must not wipe out types already
    // confirmed by an earlier explicit "Capture as LEADING SET".
    newLeadingTypeKeys: { ...(resolution?.newLeadingTypeKeys ?? {}), ...r.leadingTypeKeys },
    newLeadingSetKey: r.leadingSetKey ?? resolution?.newLeadingSetKey ?? null,
    newActionKey: r.actionKey,
    diagnostics: r.diagnostics,
  };
}

figma.ui.onmessage = async (msg: any) => {
  try {
    if (msg.type === 'find-components') {
      const candidates = await findComponentCandidates(msg.scope);
      const notes: string[] = [];

      // Auto-resolve, but only when unambiguous. Two components both named
      // "gravity-list-entry" (e.g. a test library and the real library both
      // loaded in one file) are different keys for the same name — picking
      // one silently is exactly the class of wrong-key bug this plugin must
      // never introduce, so ambiguity is reported instead of guessed.
      for (const role of ['old', 'new'] as const) {
        const matches = candidates.filter((c) => c.role === role);
        const label = role === 'old' ? 'gravity-list-entry' : 'gravity-list-entry-new';
        if (matches.length === 1) {
          try {
            await captureReference(matches[0].exampleNodeId, role);
          } catch (err) {
            notes.push(`Could not resolve ${label}: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (matches.length === 0) {
          notes.push(`No ${label} found in the current selection.`);
        } else {
          notes.push(
            `Found ${matches.length} different components named "${label}" — cannot pick automatically. Narrow your selection so only the correct one is included, then scan again.`
          );
        }
      }

      figma.ui.postMessage({ type: 'find-results', candidates, notes, resolution });
      return;
    }

    if (msg.type === 'migrate') {
      if (!resolution || !resolution.oldMainKey || !resolution.newMainKey) {
        throw new Error('Resolve both the old and new reference components before running.');
      }
      componentIndex = null; // rebuild against the document's current state for this run
      instanceIndexBuilt = false;
      const scope: ScopeConfig = msg.scope;

      const roots = await getScopeRoots(scope);
      const allInstances = await collectInstances(roots);
      const { migratable, alreadyMigrated } = await classifyInstances(allInstances, resolution);

      const snapshots: InstanceSnapshot[] = [];
      for (const inst of migratable) snapshots.push(await auditInstance(inst));

      const gate = gateCheck(snapshots, resolution);
      if (!gate.ok) {
        const parts: string[] = [];
        if (gate.missingLeadingTypes.length > 0) {
          parts.push(`leading type${gate.missingLeadingTypes.length === 1 ? '' : 's'} "${gate.missingLeadingTypes.join('", "')}"`);
        }
        if (gate.actionMissing) parts.push('the action component');
        figma.ui.postMessage({
          type: 'error',
          message: `Could not resolve ${parts.join(' and ')} on gravity-list-entry-new. Halted before making any changes — make sure your selection includes an instance of gravity-list-entry-new that already uses ${
            parts.length > 1 ? 'these' : 'it'
          }, then scan and migrate again.`,
        });
        return;
      }

      const outcomes: OutcomeRow[] = alreadyMigrated.map((inst) => ({
        sourceNodeId: inst.id,
        status: 'already-migrated',
        reason: 'Already on gravity-list-entry-new; skipped for idempotency.',
      }));

      for (let i = 0; i < snapshots.length; i++) {
        const outcome = await migrateInstance(snapshots[i], resolution);
        outcomes.push(outcome);
        figma.ui.postMessage({ type: 'progress', done: i + 1, total: snapshots.length });
      }

      const report = buildReport(scopeLabel(scope), migratable.length + alreadyMigrated.length, outcomes);
      const count = (...statuses: OutcomeStatus[]) => outcomes.filter((o) => statuses.includes(o.status)).length;
      figma.ui.postMessage({
        type: 'report',
        report,
        summary: {
          scope: scopeLabel(scope),
          source: migratable.length + alreadyMigrated.length,
          migrated: count('migrated'),
          skipped: count('skipped', 'already-migrated'),
          failed: count('failed'),
          manualReview: count('manual-review'),
        },
        exceptions: outcomes
          .filter((o) => o.status !== 'migrated')
          .map((o) => ({ id: o.sourceNodeId, replacementId: o.replacementNodeId, status: o.status, reason: o.reason })),
      });
      return;
    }

    if (msg.type === 'get-selection-name') {
      const sel = figma.currentPage.selection[0];
      figma.ui.postMessage({ type: 'selection-name', name: sel ? sel.name : null });
      return;
    }
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

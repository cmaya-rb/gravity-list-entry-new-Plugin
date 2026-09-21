// Gravity List Entry migration plugin.
// Implements gravity-list-entry-new-migration.md: resolve → dry-run audit →
// pre-migration gate → per-instance migration → validation → report.

figma.showUI(__html__, { width: 420, height: 640 });

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

function findMetaContainer(node: SceneNode): SceneNode | null {
  return findChildByName(node, 'meta-container') || findChildByPath(node, ['content-container', 'meta-container']);
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
async function resolveLeadingSet(nodeId: string): Promise<Partial<Record<LeadingType, LeadingKeyInfo>>> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error('Selected node no longer exists.');

  let set: ComponentSetNode | null = null;
  if (node.type === 'COMPONENT_SET') {
    set = node as ComponentSetNode;
  } else if (node.type === 'COMPONENT') {
    const parent = (node as ComponentNode).parent;
    set = parent && parent.type === 'COMPONENT_SET' ? (parent as ComponentSetNode) : null;
  } else if (node.type === 'INSTANCE') {
    const main = await (node as InstanceNode).getMainComponentAsync();
    set = main && main.parent && main.parent.type === 'COMPONENT_SET' ? (main.parent as ComponentSetNode) : null;
  }
  if (!set) {
    throw new Error('Select the leading component set itself, one of its variants, or an instance of it.');
  }

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

async function resolveOldReference(nodeId: string): Promise<{ mainKey: string; mainName: string; leadingSetKey: string | null }> {
  const ref = await toReferenceInstance(nodeId);
  try {
    let leadingSetKey: string | null = null;
    const leadingWrap = findChildByName(ref.instance, 'leading');
    if (leadingWrap) {
      const leadingInstance = findDescendantInstance(leadingWrap);
      if (leadingInstance) {
        const leadingOwning = await getInstanceOwningKey(leadingInstance);
        leadingSetKey = leadingOwning?.key ?? null;
      }
    }
    return { mainKey: ref.owningKey, mainName: ref.owningName, leadingSetKey };
  } finally {
    ref.cleanup();
  }
}

async function resolveNewReference(nodeId: string): Promise<{
  mainKey: string;
  mainName: string;
  leadingTypeKeys: Partial<Record<LeadingType, LeadingKeyInfo>>;
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

    const leadingWrap = findChildByName(clone, 'leading');
    const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;

    if (leadingInstance) {
      const types: LeadingType[] = ['image', 'icon', 'avatar', 'flag'];
      for (const t of types) {
        const typeProp = findProp(leadingInstance, 'type');
        try {
          if (typeProp) {
            leadingInstance.setProperties({ [typeProp.key]: t });
          }
          const confirmProp = findProp(leadingInstance, 'type');
          const resolvedType = confirmProp ? String(confirmProp.value).toLowerCase() : null;
          if (resolvedType === t) {
            const leadingMain = await leadingInstance.getMainComponentAsync();
            // Use the specific variant's own key, not the owning set's key —
            // getOwningKey() would collapse every type to the same set key,
            // making swapComponent() below target the wrong node.
            if (leadingMain) leadingTypeKeys[t] = { key: leadingMain.key, name: leadingMain.name };
          }
        } catch {
          // This type variant could not be set on the new leading — leave
          // unresolved; the pre-migration gate will halt if it's required.
        }
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

  return { mainKey: ref.owningKey, mainName: ref.owningName, leadingTypeKeys, actionKey, diagnostics };
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
      const leadingWrap = findChildByName(inst, 'leading');
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
      groups.set(owning.key, { key: owning.key, name: owning.name, count: 1, exampleNodeId: node.id, pageName: page?.name ?? '' });
    }
  }
  return Array.from(groups.values());
}

// ---------------------------------------------------------------------------
// Dry-run audit — capture everything before any mutation (safety contract
// rule 10: nested state must be read before the main component swap).
// ---------------------------------------------------------------------------

async function readLeadingSnapshot(instance: InstanceNode): Promise<LeadingSnapshot | null> {
  const leadingWrap = findChildByName(instance, 'leading');
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
    const pictureRect = findChildByName(pictureNode, 'picture');
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

async function readMetaInfo(instance: InstanceNode): Promise<{ metaSlotInstance: InstanceNode | null }> {
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
  if (!metaContainer || !('children' in metaContainer)) return { metaSlotInstance: null };
  const metaSlot = findChildByName(metaContainer, 'meta-slot') || findChildByName(metaContainer, 'meta');
  if (!metaSlot || metaSlot.type !== 'INSTANCE') return { metaSlotInstance: null };
  return { metaSlotInstance: metaSlot as InstanceNode };
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
interface OverrideCapture {
  main: ComponentNode;
  props: Record<string, string | boolean>;
  texts: { path: number[]; characters: string }[];
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

  const props: Record<string, string | boolean> = {};
  const srcProps = source.componentProperties || {};
  for (const key of Object.keys(srcProps)) props[key] = srcProps[key].value as string | boolean;

  function collectText(node: SceneNode, path: number[], out: { path: number[]; characters: string }[]): void {
    if (node.type === 'TEXT') out.push({ path: [...path], characters: (node as TextNode).characters });
    if ('children' in node) {
      (node as ChildrenMixin).children.forEach((child, idx) => collectText(child as SceneNode, [...path, idx], out));
    }
  }
  const texts: { path: number[]; characters: string }[] = [];
  collectText(source, [], texts);

  return { main, props, texts };
}

// Swaps `target` to the captured component, then reapplies the captured
// component-property and text overrides onto it — swapComponent() alone
// only changes WHICH component is displayed, e.g. a status badge's own
// slotted label text and color are not carried over automatically.
async function applyOverrideCapture(target: InstanceNode, captured: OverrideCapture): Promise<void> {
  target.swapComponent(captured.main);

  for (const key of Object.keys(captured.props)) {
    try {
      target.setProperties({ [key]: captured.props[key] });
    } catch {
      // property may not exist/be settable post-swap in edge cases — skip
    }
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
}

async function applyMappings(
  target: InstanceNode,
  snapshot: InstanceSnapshot,
  res: Resolution,
  preCapturedMeta?: OverrideCapture | null
): Promise<void> {
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
    const leadingWrap = findChildByName(target, 'leading');
    const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
    if (!leadingInstance) {
      throw new Error('New leading instance not found after main component swap.');
    }

    // The main-component swap does NOT guarantee this nested leading is
    // already on the new leading component — it can still default to the
    // OLD leading. A "type" value match (e.g. both happen to have
    // type=icon) is not proof of identity, since old and new leading sets
    // can share the same enum values. Explicitly verify by component key
    // and correct it if wrong — this is the one thing that must never be
    // silently accepted.
    const requiredLeading = res.newLeadingTypeKeys[snapshot.leading.type as LeadingType];
    if (!requiredLeading) throw new Error(`No resolved new leading component for type "${snapshot.leading.type}".`);
    const currentKey = await getInstanceComponentKey(leadingInstance);
    if (currentKey !== requiredLeading.key) {
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

    if (snapshot.leading.type === 'image') {
      const img = findChildByName(leadingInstance, 'image');
      const imgInner = img ? findChildByName(img, 'image') : null;
      const fillTarget = imgInner ?? img;
      if (fillTarget && snapshot.leading.imageFills && 'fills' in fillTarget) {
        (fillTarget as GeometryMixin).fills = snapshot.leading.imageFills;
      }
    } else if (snapshot.leading.type === 'icon') {
      if (!snapshot.leading.iconIsDefault && snapshot.leading.iconName) {
        setPropByBase(leadingInstance, 'icon-name', snapshot.leading.iconName);
      }
    } else if (snapshot.leading.type === 'avatar') {
      if (snapshot.leading.avatarInitials !== undefined) setPropByBase(leadingInstance, 'initials', snapshot.leading.avatarInitials);
      if (snapshot.leading.avatarPicture !== undefined) setPropByBase(leadingInstance, 'picture', snapshot.leading.avatarPicture);
      const avatarNode = findChildByName(leadingInstance, 'avatar') || leadingInstance;
      const pictureRect = findChildByName(avatarNode, 'picture');
      if (pictureRect && snapshot.leading.avatarPictureFill && 'fills' in pictureRect) {
        (pictureRect as GeometryMixin).fills = snapshot.leading.avatarPictureFill;
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
  // source meta instance's own overrides (e.g. a status badge's slotted
  // label text and color) — swapComponent() only changes WHICH component is
  // displayed, it does not carry those overrides across on its own. Never
  // clone/append a node, which Figma structurally forbids inside an
  // instance's tree ("Cannot move node. New parent is an instance...").
  if (snapshot.metaSlotInstance || preCapturedMeta) {
    const newMetaContainer = findMetaContainer(target);
    const newMetaSlot = newMetaContainer ? findChildByName(newMetaContainer, 'meta-slot') || findChildByName(newMetaContainer, 'meta') : null;
    if (!newMetaSlot || newMetaSlot.type !== 'INSTANCE') {
      throw new Error('Could not preserve meta content — meta slot instance not found on the new instance.');
    }
    const captured = preCapturedMeta ?? (await captureOverrides(snapshot.metaSlotInstance!));
    if (!captured) throw new Error("Could not read the meta slot's current component.");
    await applyOverrideCapture(newMetaSlot as InstanceNode, captured);
  }
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
      await applyMappings(sourceInstance, snapshot, res, preCapturedMeta);
      const problems = await validateReplacement(sourceInstance, snapshot, res);
      if (problems.length > 0) throw new Error(problems.join('; '));
      return {
        sourceNodeId: snapshot.nodeId,
        replacementNodeId: sourceInstance.id,
        status: 'migrated',
        reason: 'Validated and swapped in place (nested inside another instance — cannot be replaced as a separate node).',
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

    await applyMappings(replacement, snapshot, res);

    const problems = await validateReplacement(replacement, snapshot, res);
    if (problems.length > 0) {
      replacement.remove();
      return { sourceNodeId: snapshot.nodeId, status: 'failed', reason: problems.join('; ') };
    }

    sourceInstance.remove();
    return { sourceNodeId: snapshot.nodeId, replacementNodeId: replacement.id, status: 'migrated', reason: 'Validated and replaced.' };
  } catch (err) {
    replacement.remove();
    return { sourceNodeId: snapshot.nodeId, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

// Standalone corrective pass — scans already-migrated gravity-list-entry-new
// instances and swaps any leading that isn't on the correct new leading
// component, using the leading types captured directly from the leading set
// (never from cycling). Runs independently of the main migration so it can
// clean up instances migrated before that capture was fixed.
async function fixLeadingOnMigrated(
  scope: ScopeConfig,
  res: Resolution
): Promise<{ fixed: number; alreadyCorrect: number; skipped: number; failed: number; exceptions: string[] }> {
  const roots = await getScopeRoots(scope);
  const allInstances = await collectInstances(roots);
  let fixed = 0;
  let alreadyCorrect = 0;
  let skipped = 0;
  let failed = 0;
  const exceptions: string[] = [];

  for (const inst of allInstances) {
    // The whole body is wrapped: collectInstances() snapshots every instance
    // (including nested leading sub-instances) up front, but swapComponent()
    // on an earlier iteration can invalidate a later iteration's stale
    // reference to a now-replaced nested node ("does not exist" on
    // getMainComponentAsync) — one bad reference must not abort the whole
    // pass.
    // A stale reference always fails on this very first, basic check — a
    // real top-level list-entry never would. Treat that specific failure as
    // "this entry no longer exists, skip silently" rather than a real
    // failure, so residual duplicate entries don't get reported as errors.
    let owning: { key: string; name: string } | null;
    try {
      owning = await getInstanceOwningKey(inst);
    } catch {
      continue;
    }
    if (!owning || owning.key !== res.newMainKey) continue; // only already-migrated instances

    try {
      const leadingWrap = findChildByName(inst, 'leading');
      const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
      if (!leadingInstance) continue; // no leading on this instance

      const typeProp = findProp(leadingInstance, 'type');
      const t = typeProp ? (String(typeProp.value).toLowerCase() as LeadingType) : null;
      if (!t || !(['image', 'icon', 'avatar', 'flag'] as string[]).includes(t)) {
        skipped++;
        continue;
      }

      const required = res.newLeadingTypeKeys[t];
      if (!required) {
        skipped++;
        exceptions.push(`${inst.id} — skipped — no captured leading key for type "${t}"`);
        continue;
      }

      const currentKey = await getInstanceComponentKey(leadingInstance);
      if (currentKey === required.key) {
        alreadyCorrect++;
        continue;
      }

      const correctComponent = await resolveComponentByKey(required.key);
      leadingInstance.swapComponent(correctComponent.type === 'COMPONENT_SET' ? correctComponent.defaultVariant : correctComponent);
      const finalKey = await getInstanceComponentKey(leadingInstance);
      if (finalKey !== required.key) throw new Error('Swap did not stick.');
      fixed++;
    } catch (err) {
      failed++;
      exceptions.push(`${inst.id} — failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { fixed, alreadyCorrect, skipped, failed, exceptions };
}

async function validateReplacement(replacement: InstanceNode, snapshot: InstanceSnapshot, res: Resolution): Promise<string[]> {
  const problems: string[] = [];
  const owning = await getInstanceOwningKey(replacement);
  if (!owning || owning.key !== res.newMainKey) problems.push('Destination main component key does not match the resolved new component.');

  if (snapshot.leading && snapshot.leading.type !== 'unknown') {
    const leadingWrap = findChildByName(replacement, 'leading');
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

figma.ui.onmessage = async (msg: any) => {
  try {
    if (msg.type === 'find-components') {
      const candidates = await findComponentCandidates(msg.scope);
      figma.ui.postMessage({ type: 'find-results', candidates });
      return;
    }

    if (msg.type === 'capture-old') {
      const nodeId: string | undefined = msg.nodeId ?? figma.currentPage.selection[0]?.id;
      if (!nodeId) throw new Error('Select an instance of the old gravity-list-entry first, or use Find components.');
      const r = await resolveOldReference(nodeId);
      resolution = {
        oldMainKey: r.mainKey,
        oldMainName: r.mainName,
        newMainKey: resolution?.newMainKey ?? '',
        newMainName: resolution?.newMainName ?? '',
        oldLeadingSetKey: r.leadingSetKey,
        newLeadingTypeKeys: resolution?.newLeadingTypeKeys ?? {},
        newActionKey: resolution?.newActionKey ?? null,
        diagnostics: resolution?.diagnostics ?? [],
      };
      figma.ui.postMessage({ type: 'resolution-updated', resolution });
      return;
    }

    if (msg.type === 'capture-new') {
      const nodeId: string | undefined = msg.nodeId ?? figma.currentPage.selection[0]?.id;
      if (!nodeId) throw new Error('Select an instance of gravity-list-entry-new first (dragged from the Assets panel), or use Find components.');
      const r = await resolveNewReference(nodeId);
      resolution = {
        oldMainKey: resolution?.oldMainKey ?? '',
        oldMainName: resolution?.oldMainName ?? '',
        newMainKey: r.mainKey,
        newMainName: r.mainName,
        oldLeadingSetKey: resolution?.oldLeadingSetKey ?? null,
        newLeadingTypeKeys: r.leadingTypeKeys,
        newActionKey: r.actionKey,
        diagnostics: r.diagnostics,
      };
      figma.ui.postMessage({ type: 'resolution-updated', resolution });
      return;
    }

    if (msg.type === 'capture-leading') {
      const nodeId: string | undefined = msg.nodeId ?? figma.currentPage.selection[0]?.id;
      if (!nodeId) throw new Error('Select the leading component set, one of its variants, or an instance of it.');
      const leadingTypeKeys = await resolveLeadingSet(nodeId);
      resolution = {
        oldMainKey: resolution?.oldMainKey ?? '',
        oldMainName: resolution?.oldMainName ?? '',
        newMainKey: resolution?.newMainKey ?? '',
        newMainName: resolution?.newMainName ?? '',
        oldLeadingSetKey: resolution?.oldLeadingSetKey ?? null,
        newLeadingTypeKeys: leadingTypeKeys,
        newActionKey: resolution?.newActionKey ?? null,
        diagnostics: resolution?.diagnostics ?? [],
      };
      figma.ui.postMessage({ type: 'resolution-updated', resolution });
      return;
    }

    if (msg.type === 'fix-leading') {
      if (!resolution || Object.keys(resolution.newLeadingTypeKeys).length === 0) {
        figma.ui.postMessage({ type: 'error', message: 'Capture the leading set first (see step 1).' });
        return;
      }
      componentIndex = null;
      instanceIndexBuilt = false;
      const scope: ScopeConfig = msg.scope;
      const result = await fixLeadingOnMigrated(scope, resolution);
      figma.ui.postMessage({ type: 'fix-leading-result', result });
      return;
    }

    if (msg.type === 'audit' || msg.type === 'migrate') {
      if (!resolution || !resolution.oldMainKey || !resolution.newMainKey) {
        throw new Error('Resolve both the old and new reference components before running.');
      }
      componentIndex = null; // rebuild against the document's current state for this run
      instanceIndexBuilt = false;
      const scope: ScopeConfig = msg.scope;
      const maxBatch: number = msg.maxBatch;

      const roots = await getScopeRoots(scope);
      const allInstances = await collectInstances(roots);
      const { migratable, alreadyMigrated } = await classifyInstances(allInstances, resolution);

      if (migratable.length > maxBatch) {
        figma.ui.postMessage({
          type: 'error',
          message: `Discovered ${migratable.length} migratable instances, which exceeds the approved batch size of ${maxBatch}. Halted before making changes.`,
        });
        return;
      }

      const snapshots: InstanceSnapshot[] = [];
      for (const inst of migratable) snapshots.push(await auditInstance(inst));

      const gate = gateCheck(snapshots, resolution);
      if (!gate.ok) {
        const parts: string[] = [];
        if (gate.missingLeadingTypes.length > 0) parts.push(`missing leading types: ${gate.missingLeadingTypes.join(', ')}`);
        if (gate.actionMissing) parts.push('missing new action component');
        figma.ui.postMessage({
          type: 'error',
          message: `Pre-migration gate failed (${parts.join('; ')}). Halted before making changes — resolve these by capturing a NEW reference instance that already has these variants/action in use, then re-run.`,
        });
        return;
      }

      if (msg.type === 'audit') {
        figma.ui.postMessage({
          type: 'audit-result',
          migratable: migratable.length,
          alreadyMigrated: alreadyMigrated.length,
          detachedNote: 'Detached instances are not automatically detected — see notes.',
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
      figma.ui.postMessage({ type: 'report', report });
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

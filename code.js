"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };

  // src/code.ts
  figma.showUI(__html__, { width: 400, height: 720 });
  var resolution = null;
  var componentIndex = null;
  var instanceIndexBuilt = false;
  async function buildComponentIndex() {
    await figma.loadAllPagesAsync();
    const index = /* @__PURE__ */ new Map();
    function visit(node) {
      if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
        index.set(node.key, node);
      }
      if ("children" in node) {
        for (const child of node.children) visit(child);
      }
    }
    for (const page of figma.root.children) visit(page);
    return index;
  }
  async function indexInstancesByMainComponentKey(index) {
    const instances = [];
    function visit(node) {
      if (node.type === "INSTANCE") instances.push(node);
      if ("children" in node) {
        for (const child of node.children) visit(child);
      }
    }
    for (const page of figma.root.children) visit(page);
    await Promise.all(
      instances.map(async (inst) => {
        try {
          const main = await inst.getMainComponentAsync();
          if (main && !index.has(main.key)) index.set(main.key, main);
        } catch (e) {
        }
      })
    );
  }
  async function resolveComponentByKey(key) {
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
    } catch (e) {
      return await figma.importComponentSetByKeyAsync(key);
    }
  }
  function normalizeBase(name) {
    return name.trim().toLowerCase().replace(/^~\s+/, "~");
  }
  function findChildByName(node, name) {
    if (!("children" in node)) return null;
    const target = name.toLowerCase();
    for (const child of node.children) {
      if (child.name.toLowerCase() === target) return child;
    }
    return null;
  }
  function findChildByStructuralName(node, name) {
    var _a;
    const exact = findChildByName(node, name);
    if (exact) return exact;
    if (!("children" in node)) return null;
    const target = name.toLowerCase();
    for (const child of node.children) {
      const parts = child.name.split("/");
      const lastPart = (_a = parts[parts.length - 1]) == null ? void 0 : _a.trim().toLowerCase();
      if (parts.length > 1 && lastPart === target) return child;
    }
    return null;
  }
  function findChildByPath(node, path) {
    let current = node;
    for (const segment of path) {
      if (!current) return null;
      current = findChildByName(current, segment);
    }
    return current;
  }
  function findActionsFrame(node) {
    return findChildByName(node, "actions") || findChildByPath(node, ["content-container", "actions"]);
  }
  function findDescendantInstance(node) {
    if (node.type === "INSTANCE") return node;
    if (!("children" in node)) return null;
    for (const child of node.children) {
      const found = findDescendantInstance(child);
      if (found) return found;
    }
    return null;
  }
  function findProp(instance, base) {
    const props = instance.componentProperties || {};
    const target = normalizeBase(base);
    for (const key of Object.keys(props)) {
      const nb = normalizeBase(key.split("#")[0]);
      if (nb === target) {
        const p = props[key];
        return { key, value: p.value, type: p.type };
      }
    }
    return null;
  }
  function findPropAny(instance, bases) {
    for (const base of bases) {
      const found = findProp(instance, base);
      if (found) return found;
    }
    return null;
  }
  var META_CONTAINER_NAMES = ["meta-container", "meta-wrap"];
  function findMetaContainer(node) {
    for (const name of META_CONTAINER_NAMES) {
      const direct = findChildByStructuralName(node, name);
      if (direct) return direct;
    }
    const contentContainer = findChildByName(node, "content-container");
    if (!contentContainer) return null;
    for (const name of META_CONTAINER_NAMES) {
      const nested = findChildByStructuralName(contentContainer, name);
      if (nested) return nested;
    }
    return null;
  }
  async function getOwningKey(component) {
    if (component.parent && component.parent.type === "COMPONENT_SET") {
      const set = component.parent;
      return { key: set.key, name: set.name };
    }
    return { key: component.key, name: component.name };
  }
  async function getInstanceOwningKey(instance) {
    const main = await instance.getMainComponentAsync();
    if (!main) return null;
    return getOwningKey(main);
  }
  async function getInstanceComponentKey(instance) {
    const main = await instance.getMainComponentAsync();
    return main ? main.key : null;
  }
  function fillsSnapshot(node) {
    if (!node || !("fills" in node)) return void 0;
    const fills = node.fills;
    if (fills === figma.mixed || !Array.isArray(fills)) return void 0;
    return fills.map((f) => JSON.parse(JSON.stringify(f)));
  }
  async function toReferenceInstance(nodeId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) throw new Error("Selected node no longer exists.");
    if (node.type === "INSTANCE") {
      const instance = node;
      const owning = await getInstanceOwningKey(instance);
      if (!owning) throw new Error("Could not read the main component of the selected instance.");
      return { owningKey: owning.key, owningName: owning.name, instance, cleanup: () => {
      } };
    }
    if (node.type === "COMPONENT_SET") {
      const set = node;
      const temp = set.defaultVariant.createInstance();
      temp.x = set.x;
      temp.y = set.y - set.height - 200;
      return { owningKey: set.key, owningName: set.name, instance: temp, cleanup: () => temp.remove() };
    }
    if (node.type === "COMPONENT") {
      const comp = node;
      const owning = await getOwningKey(comp);
      const temp = comp.createInstance();
      temp.x = comp.x;
      temp.y = comp.y - comp.height - 200;
      return { owningKey: owning.key, owningName: owning.name, instance: temp, cleanup: () => temp.remove() };
    }
    throw new Error("Selected node must be a component instance, component, or component set.");
  }
  function readLeadingTypesFromSet(set) {
    var _a;
    const result = {};
    for (const child of set.children) {
      const vp = child.variantProperties || {};
      const typeKey = Object.keys(vp).find((k) => normalizeBase(k) === "type");
      const t = typeKey ? (_a = vp[typeKey]) == null ? void 0 : _a.toLowerCase() : null;
      if (t && ["image", "icon", "avatar", "flag"].includes(t)) {
        result[t] = { key: child.key, name: child.name };
      }
    }
    return result;
  }
  function detectReferenceRoleFromName(name) {
    const n = name.trim().toLowerCase();
    if (n === "gravity-list-entry-new") return "new";
    if (n === "gravity-list-entry") return "old";
    return null;
  }
  async function resolveOldReference(nodeId) {
    var _a;
    const ref = await toReferenceInstance(nodeId);
    const diagnostics = [];
    const childNames = (n) => n && "children" in n ? n.children.map((c) => `${c.name} [${c.type}]`).join(", ") : "(none)";
    try {
      let leadingSetKey = null;
      const leadingWrap = findChildByStructuralName(ref.instance, "leading");
      if (!leadingWrap) {
        diagnostics.push(`OLD: no "leading" child found. Root children: ${childNames(ref.instance)}`);
      } else {
        const leadingInstance = findDescendantInstance(leadingWrap);
        if (!leadingInstance) {
          diagnostics.push(`OLD: found a "leading" child (type ${leadingWrap.type}) but it isn't/doesn't contain an instance.`);
        } else {
          const leadingOwning = await getInstanceOwningKey(leadingInstance);
          if (!leadingOwning) {
            diagnostics.push("OLD: found the leading instance but could not read its main component (getMainComponentAsync returned null \u2014 possibly detached).");
          }
          leadingSetKey = (_a = leadingOwning == null ? void 0 : leadingOwning.key) != null ? _a : null;
        }
      }
      return { mainKey: ref.owningKey, mainName: ref.owningName, leadingSetKey, diagnostics };
    } finally {
      ref.cleanup();
    }
  }
  async function resolveNewReference(nodeId, oldLeadingSetKey) {
    var _a;
    const ref = await toReferenceInstance(nodeId);
    const clone = ref.instance.clone();
    clone.x = ref.instance.x + ref.instance.width + 400;
    clone.y = ref.instance.y;
    const leadingTypeKeys = {};
    let leadingSetKey = null;
    let actionKey = null;
    const diagnostics = [];
    const childNames = (n) => n && "children" in n ? n.children.map((c) => `${c.name} [${c.type}]`).join(", ") : "(none)";
    try {
      const actionsBoolProp = findProp(clone, "~ actions") || findProp(clone, "actions");
      if (actionsBoolProp) {
        try {
          clone.setProperties({ [actionsBoolProp.key]: true });
        } catch (e) {
        }
      }
      const leadingWrap = findChildByStructuralName(clone, "leading");
      const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
      if (leadingInstance) {
        const leadingMain = await leadingInstance.getMainComponentAsync();
        const leadingSet = ((_a = leadingMain == null ? void 0 : leadingMain.parent) == null ? void 0 : _a.type) === "COMPONENT_SET" ? leadingMain.parent : null;
        if (!leadingSet) {
          diagnostics.push("Could not determine the leading's component set.");
        } else if (oldLeadingSetKey && leadingSet.key === oldLeadingSetKey) {
          diagnostics.push(
            `This reference's leading is still on the OLD leading component set \u2014 cannot auto-resolve from it. Use "Capture selection as LEADING SET" on a confirmed-correct leading instead.`
          );
        } else if (oldLeadingSetKey && leadingSet.key !== oldLeadingSetKey) {
          Object.assign(leadingTypeKeys, readLeadingTypesFromSet(leadingSet));
          leadingSetKey = leadingSet.key;
        } else if (leadingSet.name.toLowerCase().includes(ref.owningName.toLowerCase())) {
          Object.assign(leadingTypeKeys, readLeadingTypesFromSet(leadingSet));
          leadingSetKey = leadingSet.key;
        } else {
          diagnostics.push(
            `Cannot verify this leading automatically \u2014 its component set ("${leadingSet.name}") isn't named as owned by "${ref.owningName}". Capture OLD first, or use "Capture selection as LEADING SET" explicitly.`
          );
        }
      } else {
        diagnostics.push(`No "leading" child found. Root children: ${childNames(clone)}`);
      }
      const actionsFrame = findActionsFrame(clone);
      if (actionsFrame && "children" in actionsFrame) {
        const firstAction = actionsFrame.children.find(
          (c) => c.type === "INSTANCE" && /action/i.test(c.name) && !/overflow/i.test(c.name)
        );
        if (firstAction) {
          const actionMain = await firstAction.getMainComponentAsync();
          if (actionMain) actionKey = await getOwningKey(actionMain);
        } else {
          diagnostics.push(`Found actions frame "${actionsFrame.name}" but no child instance matched /action/i. Its children: ${childNames(actionsFrame)}`);
        }
      } else {
        const contentContainer = findChildByName(clone, "content-container");
        diagnostics.push(
          `No "actions" or "action-container" frame found. Root children: ${childNames(clone)}` + (contentContainer ? `. content-container children: ${childNames(contentContainer)}` : "")
        );
      }
    } finally {
      clone.remove();
      ref.cleanup();
    }
    const missing = ["image", "icon", "avatar", "flag"].filter((t) => !leadingTypeKeys[t]);
    if (missing.length > 0) {
      await scanForLeadingTypeExamples(ref.owningKey, leadingTypeKeys);
    }
    return { mainKey: ref.owningKey, mainName: ref.owningName, leadingTypeKeys, leadingSetKey, actionKey, diagnostics };
  }
  async function scanForLeadingTypeExamples(newMainKey, leadingTypeKeys) {
    await figma.loadAllPagesAsync();
    const instances = [];
    function visit(node) {
      if (node.type === "INSTANCE") instances.push(node);
      if ("children" in node) {
        for (const child of node.children) visit(child);
      }
    }
    for (const page of figma.root.children) visit(page);
    await Promise.all(
      instances.map(async (inst) => {
        const owning = await getInstanceOwningKey(inst);
        if (!owning || owning.key !== newMainKey) return;
        const leadingWrap = findChildByStructuralName(inst, "leading");
        const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
        if (!leadingInstance) return;
        const typeProp = findProp(leadingInstance, "type");
        const t = typeProp ? String(typeProp.value).toLowerCase() : null;
        if (!t || !["image", "icon", "avatar", "flag"].includes(t) || leadingTypeKeys[t]) return;
        const leadingMain = await leadingInstance.getMainComponentAsync();
        if (leadingMain) leadingTypeKeys[t] = { key: leadingMain.key, name: leadingMain.name };
      })
    );
  }
  async function getScopeRoots(scope) {
    if (scope.mode === "selection") return figma.currentPage.selection;
    if (scope.mode === "current-page") return [figma.currentPage];
    if (scope.mode === "all-pages") {
      await figma.loadAllPagesAsync();
      return figma.root.children;
    }
    if (scope.mode === "named-pages") {
      await figma.loadAllPagesAsync();
      const names = new Set((scope.pageNames || []).map((n) => n.trim().toLowerCase()));
      return figma.root.children.filter((p) => names.has(p.name.toLowerCase()));
    }
    return [];
  }
  async function collectInstances(roots) {
    const out = [];
    async function visit(node) {
      if (node.type === "INSTANCE") out.push(node);
      if ("children" in node) {
        for (const child of node.children) {
          await visit(child);
        }
      }
    }
    for (const r of roots) await visit(r);
    return out;
  }
  async function classifyInstances(instances, res) {
    const migratable = [];
    const alreadyMigrated = [];
    const unrelated = [];
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
  async function collectCandidateNodes(roots) {
    const out = [];
    async function visit(node) {
      const t = node.type;
      if (t === "INSTANCE") {
        out.push(node);
      } else if (t === "COMPONENT_SET") {
        out.push(node);
        return;
      } else if (t === "COMPONENT") {
        const comp = node;
        if (!comp.parent || comp.parent.type !== "COMPONENT_SET") out.push(comp);
        return;
      }
      if ("children" in node) {
        for (const child of node.children) {
          await visit(child);
        }
      }
    }
    for (const r of roots) await visit(r);
    return out;
  }
  async function findComponentCandidates(scope) {
    var _a;
    const roots = await getScopeRoots(scope);
    const nodes = await collectCandidateNodes(roots);
    const owningKeys = await Promise.all(
      nodes.map(
        (node) => node.type === "INSTANCE" ? getInstanceOwningKey(node) : node.type === "COMPONENT_SET" ? Promise.resolve({ key: node.key, name: node.name }) : getOwningKey(node)
      )
    );
    const groups = /* @__PURE__ */ new Map();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const owning = owningKeys[i];
      if (!owning || !/list-entry/i.test(owning.name) || owning.name.includes("/")) continue;
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
          pageName: (_a = page == null ? void 0 : page.name) != null ? _a : "",
          role: detectReferenceRoleFromName(owning.name)
        });
      }
    }
    return Array.from(groups.values());
  }
  async function readLeadingSnapshot(instance) {
    const leadingWrap = findChildByStructuralName(instance, "leading");
    if (!leadingWrap) return null;
    const leadingInstance = findDescendantInstance(leadingWrap);
    if (!leadingInstance) return null;
    const typeProp = findProp(leadingInstance, "type");
    const type = typeProp ? String(typeProp.value).toLowerCase() : null;
    if (type === "image") {
      const img = findChildByName(leadingInstance, "image");
      return { type: "image", imageFills: fillsSnapshot(img) };
    }
    if (type === "icon") {
      const iconNameProp = findProp(leadingInstance, "icon-name");
      const iconName = iconNameProp ? String(iconNameProp.value) : void 0;
      return { type: "icon", iconName, iconIsDefault: !iconName || iconName === "gravity-icon-bull" };
    }
    if (type === "avatar") {
      const initialsProp = findProp(leadingInstance, "initials");
      const pictureProp = findProp(leadingInstance, "picture");
      const pictureNode = findChildByName(leadingInstance, "gravity-avatar") || leadingInstance;
      const pictureRect = findChildByName(pictureNode, "picture");
      return {
        type: "avatar",
        avatarInitials: initialsProp ? String(initialsProp.value) : void 0,
        avatarPicture: pictureProp ? Boolean(pictureProp.value) : void 0,
        avatarPictureFill: fillsSnapshot(pictureRect)
      };
    }
    if (type === "flag") {
      const countryProp = findProp(leadingInstance, "country-name");
      const codeProp = findProp(leadingInstance, "code");
      return {
        type: "flag",
        flagCountryName: countryProp ? String(countryProp.value) : void 0,
        flagCode: codeProp ? String(codeProp.value) : void 0
      };
    }
    return { type: "unknown" };
  }
  function readActionSnapshot(instance, hasAction) {
    if (!hasAction) return { present: false };
    const actionContainer = findChildByName(instance, "action-container");
    const actionInstance = actionContainer ? findDescendantInstance(actionContainer) : findDescendantInstance(instance);
    if (!actionInstance) return { present: false };
    const labelProp = findProp(actionInstance, "label");
    const iconNameProp = findProp(actionInstance, "icon-name");
    const iconPositionProp = findProp(actionInstance, "~ icon-position");
    return {
      present: true,
      label: labelProp ? String(labelProp.value) : void 0,
      iconName: iconNameProp ? String(iconNameProp.value) : void 0,
      iconPosition: iconPositionProp ? String(iconPositionProp.value) : void 0
    };
  }
  function childNameList(node) {
    if (!("children" in node)) return "(no children)";
    const names = node.children.map((c) => `${c.name} [${c.type}]`);
    return names.length > 0 ? names.join(", ") : "(empty)";
  }
  async function readMetaInfo(instance) {
    const metaContainer = findMetaContainer(instance);
    if (!metaContainer || !("children" in metaContainer)) {
      return {
        metaSlotInstance: null,
        metaDiagnostic: `no meta-container found \u2014 top-level children: ${childNameList(instance)}`
      };
    }
    const metaSlot = findDescendantInstance(metaContainer);
    if (!metaSlot) {
      return {
        metaSlotInstance: null,
        metaDiagnostic: `meta-container "${metaContainer.name}" found, but no instance inside it at all \u2014 its children: ${childNameList(metaContainer)}`
      };
    }
    return { metaSlotInstance: metaSlot, metaDiagnostic: null };
  }
  async function auditInstance(instance) {
    var _a, _b, _c;
    const page = instance.parent ? findPageOf(instance) : figma.currentPage;
    const parent = instance.parent;
    const siblingIndex = parent && "children" in parent ? parent.children.indexOf(instance) : -1;
    const vp = instance.variantProperties || {};
    const readVariant = (base) => {
      const key = Object.keys(vp).find((k) => normalizeBase(k) === normalizeBase(base));
      return key ? vp[key] : null;
    };
    const readVariantBool = (base) => readVariant(base) === "true" || readVariant(base) === "True";
    const variant = {
      width: readVariant("~ width"),
      type: readVariant("type"),
      presentational: readVariantBool("presentational"),
      state: readVariant("~ state"),
      selected: readVariantBool("selected"),
      action: readVariantBool("action")
    };
    const headingProp = findProp(instance, "title");
    const descriptionProp = findProp(instance, "description");
    const leadingBoolProp = findProp(instance, "~ leading");
    const descriptionBoolProp = findProp(instance, "~ description");
    const focusBoolProp = findProp(instance, "~ focus");
    const switchesContextProp = findPropAny(instance, ["switchesContext", "switches-context"]);
    const metaBoolProp = findProp(instance, "~ meta");
    const persistentProp = findProp(instance, "persistent");
    const leading = leadingBoolProp && leadingBoolProp.value === false ? null : await readLeadingSnapshot(instance);
    const action = readActionSnapshot(instance, variant.action);
    const meta = await readMetaInfo(instance);
    return {
      nodeId: instance.id,
      pageId: (_a = page == null ? void 0 : page.id) != null ? _a : "",
      pageName: (_b = page == null ? void 0 : page.name) != null ? _b : "",
      parentId: (_c = parent == null ? void 0 : parent.id) != null ? _c : "",
      siblingIndex,
      x: instance.x,
      y: instance.y,
      width: instance.width,
      height: instance.height,
      rotation: instance.rotation,
      visible: instance.visible,
      opacity: instance.opacity,
      blendMode: instance.blendMode,
      layoutAlign: "layoutAlign" in instance ? instance.layoutAlign : void 0,
      layoutPositioning: "layoutPositioning" in instance ? instance.layoutPositioning : void 0,
      constraints: "constraints" in instance ? instance.constraints : void 0,
      reactions: "reactions" in instance ? JSON.parse(JSON.stringify(instance.reactions)) : void 0,
      variant,
      heading: headingProp ? String(headingProp.value) : null,
      description: descriptionProp ? String(descriptionProp.value) : null,
      bool: {
        leading: leadingBoolProp ? Boolean(leadingBoolProp.value) : null,
        description: descriptionBoolProp ? Boolean(descriptionBoolProp.value) : null,
        focus: focusBoolProp ? Boolean(focusBoolProp.value) : null,
        switchesContext: switchesContextProp ? Boolean(switchesContextProp.value) : null,
        meta: metaBoolProp ? Boolean(metaBoolProp.value) : null,
        persistent: persistentProp ? Boolean(persistentProp.value) : null
      },
      leading,
      action,
      metaSlotInstance: meta.metaSlotInstance,
      metaDiagnostic: meta.metaDiagnostic
    };
  }
  function findPageOf(node) {
    let current = node;
    while (current) {
      if (current.type === "PAGE") return current;
      current = current.parent;
    }
    return null;
  }
  function gateCheck(snapshots, res) {
    const neededTypes = /* @__PURE__ */ new Set();
    for (const s of snapshots) {
      if (s.leading && s.leading.type !== "unknown") neededTypes.add(s.leading.type);
    }
    const missingLeadingTypes = Array.from(neededTypes).filter((t) => !res.newLeadingTypeKeys[t]);
    const needsAction = snapshots.some((s) => s.variant.action);
    const actionMissing = needsAction && !res.newActionKey;
    const ok = missingLeadingTypes.length === 0 && !actionMissing;
    return { ok, missingLeadingTypes, needsAction, actionMissing };
  }
  var WIDTH_TO_SIZE = { "\u2265480px": "medium", "<480px": "small" };
  var TYPE_MAP = { bare: "bare", box: "boxed" };
  var STATE_MAP = { initial: "initial", hover: "hover", active: "hover" };
  function setPropByBase(instance, base, value) {
    const props = instance.componentProperties || {};
    const target = normalizeBase(base);
    for (const key of Object.keys(props)) {
      if (normalizeBase(key.split("#")[0]) === target) {
        try {
          instance.setProperties({ [key]: value });
          return true;
        } catch (e) {
          return false;
        }
      }
    }
    return false;
  }
  function isInsideLockedInstance(node) {
    let current = node;
    while (current) {
      if (current.type === "INSTANCE") return true;
      if (current.type === "PAGE") return false;
      current = current.parent;
    }
    return false;
  }
  var STYLE_KEYS = [
    "fontName",
    "fontSize",
    "textCase",
    "textDecoration",
    "letterSpacing",
    "lineHeight",
    "textAlignHorizontal",
    "textAlignVertical",
    "textAutoResize",
    "paragraphSpacing",
    "paragraphIndent",
    "opacity",
    "blendMode",
    "effects",
    "strokeWeight",
    "strokeAlign",
    "strokeCap",
    "strokeJoin",
    "dashPattern",
    "cornerRadius",
    "topLeftRadius",
    "topRightRadius",
    "bottomLeftRadius",
    "bottomRightRadius",
    "cornerSmoothing",
    "rotation",
    "layoutAlign",
    "layoutGrow",
    "layoutPositioning",
    "clipsContent",
    "constraints",
    "isMask"
  ];
  function paintsSnapshot(node, kind) {
    if (!(kind in node)) return void 0;
    const value = node[kind];
    if (value === figma.mixed || !Array.isArray(value)) return void 0;
    return value.map((p) => JSON.parse(JSON.stringify(p)));
  }
  function styleIdSnapshot(node, key) {
    if (!(key in node)) return void 0;
    const v = node[key];
    return typeof v === "string" ? v : void 0;
  }
  function readNodeStyle(node, path) {
    const raw = node;
    const scalars = {};
    for (const key of STYLE_KEYS) {
      if (!(key in node)) continue;
      const v = raw[key];
      if (v === figma.mixed || v === void 0) continue;
      scalars[key] = JSON.parse(JSON.stringify(v));
    }
    return {
      path,
      name: node.name,
      fills: paintsSnapshot(node, "fills"),
      strokes: paintsSnapshot(node, "strokes"),
      fillStyleId: styleIdSnapshot(node, "fillStyleId"),
      strokeStyleId: styleIdSnapshot(node, "strokeStyleId"),
      effectStyleId: styleIdSnapshot(node, "effectStyleId"),
      textStyleId: styleIdSnapshot(node, "textStyleId"),
      reactions: "reactions" in node && raw.reactions !== void 0 ? JSON.parse(JSON.stringify(raw.reactions)) : void 0,
      scalars
    };
  }
  async function setViaAsyncOrAssign(node, asyncName, propName, value) {
    const raw = node;
    const fn = raw[asyncName];
    if (typeof fn === "function") {
      await fn.call(node, value);
    } else {
      raw[propName] = value;
    }
  }
  async function applyNodeStyle(targetNode, o, warnings) {
    const label = `meta node [${o.path.join(",")}] "${o.name}"`;
    const raw = targetNode;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const step = async (what, fn) => {
      try {
        await fn();
      } catch (err) {
        warnings.push(`${label} ${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (targetNode.name !== o.name) await step("name", () => void (targetNode.name = o.name));
    if (targetNode.type === "TEXT") {
      const t = targetNode;
      await step("font load", async () => {
        if (t.fontName !== figma.mixed) await figma.loadFontAsync(t.fontName);
        if (o.scalars.fontName) await figma.loadFontAsync(o.scalars.fontName);
      });
    }
    for (const key of STYLE_KEYS) {
      if (!(key in o.scalars) || !(key in targetNode)) continue;
      if (same(raw[key], o.scalars[key])) continue;
      await step(key, () => void (raw[key] = o.scalars[key]));
    }
    if (o.fillStyleId !== void 0 && "fillStyleId" in targetNode && raw.fillStyleId !== o.fillStyleId) {
      await step("fillStyleId", () => setViaAsyncOrAssign(targetNode, "setFillStyleIdAsync", "fillStyleId", o.fillStyleId));
    }
    if (!o.fillStyleId && o.fills && "fills" in targetNode && !same(paintsSnapshot(targetNode, "fills"), o.fills)) {
      await step("fills", () => void (targetNode.fills = o.fills));
    }
    if (o.strokeStyleId !== void 0 && "strokeStyleId" in targetNode && raw.strokeStyleId !== o.strokeStyleId) {
      await step("strokeStyleId", () => setViaAsyncOrAssign(targetNode, "setStrokeStyleIdAsync", "strokeStyleId", o.strokeStyleId));
    }
    if (!o.strokeStyleId && o.strokes && "strokes" in targetNode && !same(paintsSnapshot(targetNode, "strokes"), o.strokes)) {
      await step("strokes", () => void (targetNode.strokes = o.strokes));
    }
    if (o.effectStyleId !== void 0 && "effectStyleId" in targetNode && raw.effectStyleId !== o.effectStyleId) {
      await step("effectStyleId", () => setViaAsyncOrAssign(targetNode, "setEffectStyleIdAsync", "effectStyleId", o.effectStyleId));
    }
    if (o.textStyleId !== void 0 && targetNode.type === "TEXT" && raw.textStyleId !== o.textStyleId) {
      await step("textStyleId", () => setViaAsyncOrAssign(targetNode, "setTextStyleIdAsync", "textStyleId", o.textStyleId));
    }
    if (o.reactions !== void 0 && "reactions" in targetNode && !same(raw.reactions, o.reactions)) {
      await step("reactions", () => setViaAsyncOrAssign(targetNode, "setReactionsAsync", "reactions", o.reactions));
    }
  }
  function findChildByIndexPath(node, path) {
    let current = node;
    for (const idx of path) {
      if (!current || !("children" in current)) return null;
      const child = current.children[idx];
      if (!child) return null;
      current = child;
    }
    return current;
  }
  async function captureOverrides(source) {
    const main = await source.getMainComponentAsync();
    if (!main) return null;
    const readProps = (inst) => {
      const out = {};
      const p = inst.componentProperties || {};
      for (const key of Object.keys(p)) out[key] = p[key].value;
      return out;
    };
    const props = readProps(source);
    function collectInstanceProps(node, path, out) {
      if (path.length > 0 && node.type === "INSTANCE") {
        out.push({ path: [...path], props: readProps(node) });
      }
      if ("children" in node) {
        node.children.forEach((child, idx) => collectInstanceProps(child, [...path, idx], out));
      }
    }
    const instanceProps = [];
    collectInstanceProps(source, [], instanceProps);
    function collectText(node, path, out) {
      if (node.type === "TEXT") out.push({ path: [...path], characters: node.characters });
      if ("children" in node) {
        node.children.forEach((child, idx) => collectText(child, [...path, idx], out));
      }
    }
    const texts = [];
    collectText(source, [], texts);
    function collectVisibility(node, path, out) {
      out.push({ path: [...path], visible: node.visible });
      if ("children" in node) {
        node.children.forEach((child, idx) => collectVisibility(child, [...path, idx], out));
      }
    }
    const visibility = [];
    source.children.forEach((child, idx) => collectVisibility(child, [idx], visibility));
    function collectStyles(node, path, out) {
      out.push(readNodeStyle(node, path));
      if ("children" in node) {
        node.children.forEach((child, idx) => collectStyles(child, [...path, idx], out));
      }
    }
    const styles = [];
    collectStyles(source, [], styles);
    return { main, props, instanceProps, texts, visibility, styles };
  }
  async function applyOverrideCapture(target, captured) {
    const warnings = [];
    target.swapComponent(captured.main);
    const applyProps = (inst, props, label) => {
      for (const key of Object.keys(props)) {
        try {
          inst.setProperties({ [key]: props[key] });
        } catch (err) {
          warnings.push(`${label} "${key}" \u2192 ${String(props[key])}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    applyProps(target, captured.props, "meta root prop");
    const nested = [...captured.instanceProps].sort((a, b) => a.path.length - b.path.length);
    for (const { path, props } of nested) {
      const targetNode = findChildByIndexPath(target, path);
      if (!targetNode || targetNode.type !== "INSTANCE") {
        warnings.push(`meta nested instance at [${path.join(",")}] not found post-swap \u2014 its ${Object.keys(props).length} prop(s) dropped`);
        continue;
      }
      applyProps(targetNode, props, `meta nested [${path.join(",")}] prop`);
    }
    for (const { path, characters } of captured.texts) {
      const targetNode = findChildByIndexPath(target, path);
      if (!targetNode || targetNode.type !== "TEXT") continue;
      try {
        const font = targetNode.fontName;
        if (font !== figma.mixed) await figma.loadFontAsync(font);
        targetNode.characters = characters;
      } catch (e) {
      }
    }
    for (const { path, visible } of captured.visibility) {
      const targetNode = findChildByIndexPath(target, path);
      if (targetNode) targetNode.visible = visible;
    }
    for (const o of captured.styles) {
      const targetNode = findChildByIndexPath(target, o.path);
      if (!targetNode) {
        warnings.push(`meta node [${o.path.join(",")}] "${o.name}" missing post-swap \u2014 its style overrides dropped`);
        continue;
      }
      await applyNodeStyle(targetNode, o, warnings);
    }
    const verify = (inst, expected, label) => {
      const actual = inst.componentProperties || {};
      for (const key of Object.keys(expected)) {
        if (!(key in actual)) continue;
        if (String(actual[key].value) !== String(expected[key])) {
          warnings.push(`${label} "${key}" expected ${String(expected[key])}, is ${String(actual[key].value)}`);
        }
      }
    };
    verify(target, captured.props, "meta root prop");
    for (const { path, props } of nested) {
      const node = findChildByIndexPath(target, path);
      if (node && node.type === "INSTANCE") verify(node, props, `meta nested [${path.join(",")}] prop`);
    }
    return warnings;
  }
  async function applyMappings(target, snapshot, res, preCapturedMeta) {
    var _a, _b, _c, _d;
    if (snapshot.variant.width) setPropByBase(target, "size", (_a = WIDTH_TO_SIZE[snapshot.variant.width]) != null ? _a : snapshot.variant.width);
    if (snapshot.variant.type) setPropByBase(target, "type", (_b = TYPE_MAP[snapshot.variant.type]) != null ? _b : snapshot.variant.type);
    setPropByBase(target, "presentational", snapshot.variant.presentational);
    if (snapshot.variant.state) {
      const mappedState = snapshot.variant.presentational && (snapshot.variant.state === "hover" || snapshot.variant.state === "active") ? "initial" : (_c = STATE_MAP[snapshot.variant.state]) != null ? _c : snapshot.variant.state;
      setPropByBase(target, "~ state", mappedState);
    }
    setPropByBase(target, "selected", snapshot.variant.selected);
    setPropByBase(target, "~ actions", snapshot.variant.action);
    setPropByBase(target, "~ meta-bottom", false);
    setPropByBase(target, "~ actions-overflow", false);
    setPropByBase(target, "~ status", false);
    if (snapshot.bool.leading !== null) setPropByBase(target, "~ leading", snapshot.bool.leading);
    if (snapshot.bool.description !== null) setPropByBase(target, "~ description", snapshot.bool.description);
    if (snapshot.bool.focus !== null) setPropByBase(target, "~ focus", snapshot.bool.focus);
    if (snapshot.bool.switchesContext !== null) setPropByBase(target, "navigational", snapshot.bool.switchesContext);
    if (snapshot.bool.meta !== null) setPropByBase(target, "~ meta", snapshot.bool.meta);
    if (snapshot.bool.persistent !== null) setPropByBase(target, "actions-persistent", snapshot.bool.persistent);
    if (snapshot.heading !== null) setPropByBase(target, "heading", snapshot.heading);
    if (snapshot.description !== null) setPropByBase(target, "description", snapshot.description);
    if (snapshot.leading && snapshot.leading.type !== "unknown") {
      const leadingWrap = findChildByStructuralName(target, "leading");
      const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
      if (!leadingInstance) {
        throw new Error("New leading instance not found after main component swap.");
      }
      const requiredLeading = res.newLeadingTypeKeys[snapshot.leading.type];
      if (!requiredLeading) throw new Error(`No resolved new leading component for type "${snapshot.leading.type}".`);
      const currentOwningSet = await getInstanceOwningKey(leadingInstance);
      const onCorrectSet = res.newLeadingSetKey !== null && (currentOwningSet == null ? void 0 : currentOwningSet.key) === res.newLeadingSetKey;
      if (!onCorrectSet) {
        const correctComponent = await resolveComponentByKey(requiredLeading.key);
        leadingInstance.swapComponent(correctComponent.type === "COMPONENT_SET" ? correctComponent.defaultVariant : correctComponent);
      }
      const typeProp = findProp(leadingInstance, "type");
      if (!typeProp) throw new Error('New leading instance has no "type" property to switch.');
      leadingInstance.setProperties({ [typeProp.key]: snapshot.leading.type });
      const confirmProp = findProp(leadingInstance, "type");
      if (!confirmProp || String(confirmProp.value).toLowerCase() !== snapshot.leading.type) {
        throw new Error(`Could not switch the new leading to type "${snapshot.leading.type}".`);
      }
      const finalKey = await getInstanceComponentKey(leadingInstance);
      if (finalKey !== requiredLeading.key) {
        throw new Error("Leading is still not on the new leading component after corrective swap.");
      }
      if (res.oldLeadingSetKey) {
        const finalOwning = await getInstanceOwningKey(leadingInstance);
        if (finalOwning && finalOwning.key === res.oldLeadingSetKey) {
          throw new Error(
            'Leading resolved to the OLD leading set despite matching the captured key \u2014 the captured leading data is wrong. Re-run "Capture selection as LEADING SET" pointing at a confirmed-correct leading.'
          );
        }
      }
      if (snapshot.leading.type === "image") {
        const img = findChildByName(leadingInstance, "image");
        const imgInner = img ? findChildByName(img, "image") : null;
        const fillTarget = imgInner != null ? imgInner : img;
        if (fillTarget && snapshot.leading.imageFills && "fills" in fillTarget) {
          fillTarget.fills = snapshot.leading.imageFills;
        }
      } else if (snapshot.leading.type === "icon") {
        if (!snapshot.leading.iconIsDefault && snapshot.leading.iconName) {
          setPropByBase(leadingInstance, "icon-name", snapshot.leading.iconName);
        }
      } else if (snapshot.leading.type === "avatar") {
        if (snapshot.leading.avatarInitials !== void 0) setPropByBase(leadingInstance, "initials", snapshot.leading.avatarInitials);
        if (snapshot.leading.avatarPicture !== void 0) setPropByBase(leadingInstance, "picture", snapshot.leading.avatarPicture);
        const avatarNode = findChildByName(leadingInstance, "avatar") || leadingInstance;
        const pictureRect = findChildByName(avatarNode, "picture");
        if (pictureRect && snapshot.leading.avatarPictureFill && "fills" in pictureRect) {
          pictureRect.fills = snapshot.leading.avatarPictureFill;
        }
      } else if (snapshot.leading.type === "flag") {
        if (snapshot.leading.flagCountryName !== void 0) setPropByBase(leadingInstance, "country-name", snapshot.leading.flagCountryName);
        if (snapshot.leading.flagCode !== void 0) setPropByBase(leadingInstance, "code", snapshot.leading.flagCode);
      }
    }
    if (snapshot.action.present) {
      const actionsFrame = findActionsFrame(target);
      const firstAction = actionsFrame && "children" in actionsFrame ? actionsFrame.children.find((c) => c.type === "INSTANCE" && /^action$/i.test(c.name)) : void 0;
      if (firstAction) {
        if (snapshot.action.label !== void 0) setPropByBase(firstAction, "label", snapshot.action.label);
        if (snapshot.action.iconName !== void 0) setPropByBase(firstAction, "icon-name", snapshot.action.iconName);
        if (snapshot.action.iconPosition !== void 0) setPropByBase(firstAction, "~ icon-position", snapshot.action.iconPosition);
      }
    }
    if (snapshot.bool.meta === true && !snapshot.metaSlotInstance && !preCapturedMeta) {
      throw new Error(
        `Instance has meta enabled but its meta slot content could not be read \u2014 refusing to migrate and silently reset it. ${(_d = snapshot.metaDiagnostic) != null ? _d : ""}`
      );
    }
    if (snapshot.metaSlotInstance || preCapturedMeta) {
      const newMetaContainer = findMetaContainer(target);
      const newMetaSlot = newMetaContainer ? findDescendantInstance(newMetaContainer) : null;
      if (!newMetaSlot) {
        throw new Error(
          `Could not preserve meta content \u2014 no instance found inside the new instance's meta-container. ${newMetaContainer ? `Its children: ${childNameList(newMetaContainer)}` : "meta-container itself not found."}`
        );
      }
      const captured = preCapturedMeta != null ? preCapturedMeta : await captureOverrides(snapshot.metaSlotInstance);
      if (!captured) throw new Error("Could not read the meta slot's current component.");
      return applyOverrideCapture(newMetaSlot, captured);
    }
    return [];
  }
  async function migrateInstance(snapshot, res) {
    if (snapshot.leading && snapshot.leading.type !== "unknown" && !res.newLeadingTypeKeys[snapshot.leading.type]) {
      return {
        sourceNodeId: snapshot.nodeId,
        status: "skipped",
        reason: `Required leading type "${snapshot.leading.type}" could not be resolved on the new component \u2014 never falling back to a different type.`
      };
    }
    if (snapshot.variant.action && !res.newActionKey) {
      return { sourceNodeId: snapshot.nodeId, status: "skipped", reason: "Instance has an action but the new action component could not be resolved." };
    }
    const source = await figma.getNodeByIdAsync(snapshot.nodeId);
    if (!source || source.type !== "INSTANCE") {
      return { sourceNodeId: snapshot.nodeId, status: "failed", reason: "Source node no longer exists or is not an instance." };
    }
    const sourceInstance = source;
    const parent = sourceInstance.parent;
    if (!parent) {
      return { sourceNodeId: snapshot.nodeId, status: "failed", reason: "Source node has no parent." };
    }
    let newMainComponent;
    try {
      newMainComponent = await resolveComponentByKey(res.newMainKey);
    } catch (e) {
      return {
        sourceNodeId: snapshot.nodeId,
        status: "failed",
        reason: "Could not find the new main component in the current file, and it is not resolvable via a published library."
      };
    }
    const newMainAsComponent = newMainComponent.type === "COMPONENT_SET" ? newMainComponent.defaultVariant : newMainComponent;
    if (isInsideLockedInstance(parent)) {
      const oldMain = await sourceInstance.getMainComponentAsync();
      const preCapturedMeta = snapshot.metaSlotInstance ? await captureOverrides(snapshot.metaSlotInstance) : null;
      try {
        sourceInstance.swapComponent(newMainAsComponent);
        const warnings = await applyMappings(sourceInstance, snapshot, res, preCapturedMeta);
        const problems = await validateReplacement(sourceInstance, snapshot, res);
        if (problems.length > 0) throw new Error(problems.join("; "));
        return {
          sourceNodeId: snapshot.nodeId,
          replacementNodeId: sourceInstance.id,
          status: warnings.length > 0 ? "manual-review" : "migrated",
          reason: warnings.length > 0 ? `Swapped in place, but meta overrides did not fully stick: ${warnings.join(" | ")}` : "Validated and swapped in place (nested inside another instance \u2014 cannot be replaced as a separate node)."
        };
      } catch (err) {
        if (oldMain) {
          try {
            sourceInstance.swapComponent(oldMain);
          } catch (e) {
          }
        }
        return {
          sourceNodeId: snapshot.nodeId,
          status: "failed",
          reason: `${err instanceof Error ? err.message : String(err)} \u2014 reverted component reference; some property overrides made before the failure may remain changed.`
        };
      }
    }
    if (!("children" in parent)) {
      return { sourceNodeId: snapshot.nodeId, status: "failed", reason: "Source node has no valid parent to insert the replacement into." };
    }
    const preCapturedMetaTopLevel = snapshot.metaSlotInstance ? await captureOverrides(snapshot.metaSlotInstance) : null;
    let replacement;
    try {
      replacement = newMainAsComponent.createInstance();
    } catch (e) {
      return { sourceNodeId: snapshot.nodeId, status: "failed", reason: "Could not create an instance of the new main component." };
    }
    try {
      parent.insertChild(snapshot.siblingIndex, replacement);
      replacement.x = snapshot.x;
      replacement.y = snapshot.y;
      replacement.resize(snapshot.width, snapshot.height);
      replacement.rotation = snapshot.rotation;
      replacement.visible = snapshot.visible;
      replacement.opacity = snapshot.opacity;
      replacement.blendMode = snapshot.blendMode;
      if (snapshot.constraints && "constraints" in replacement) replacement.constraints = snapshot.constraints;
      if (snapshot.layoutAlign && "layoutAlign" in replacement) replacement.layoutAlign = snapshot.layoutAlign;
      if (snapshot.layoutPositioning && "layoutPositioning" in replacement)
        replacement.layoutPositioning = snapshot.layoutPositioning;
      const warnings = await applyMappings(replacement, snapshot, res, preCapturedMetaTopLevel);
      const problems = await validateReplacement(replacement, snapshot, res);
      if (problems.length > 0) {
        replacement.remove();
        return { sourceNodeId: snapshot.nodeId, status: "failed", reason: problems.join("; ") };
      }
      sourceInstance.remove();
      return {
        sourceNodeId: snapshot.nodeId,
        replacementNodeId: replacement.id,
        status: warnings.length > 0 ? "manual-review" : "migrated",
        reason: warnings.length > 0 ? `Replaced, but meta overrides did not fully stick: ${warnings.join(" | ")}` : "Validated and replaced."
      };
    } catch (err) {
      replacement.remove();
      return { sourceNodeId: snapshot.nodeId, status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }
  async function validateReplacement(replacement, snapshot, res) {
    const problems = [];
    const owning = await getInstanceOwningKey(replacement);
    if (!owning || owning.key !== res.newMainKey) problems.push("Destination main component key does not match the resolved new component.");
    if (snapshot.leading && snapshot.leading.type !== "unknown") {
      const leadingWrap = findChildByStructuralName(replacement, "leading");
      const leadingInstance = leadingWrap ? findDescendantInstance(leadingWrap) : null;
      const typeProp = leadingInstance ? findProp(leadingInstance, "type") : null;
      const actualType = typeProp ? String(typeProp.value).toLowerCase() : null;
      if (actualType !== snapshot.leading.type) {
        problems.push(`Leading type mismatch: expected "${snapshot.leading.type}", got "${actualType}".`);
      }
      const requiredLeading = res.newLeadingTypeKeys[snapshot.leading.type];
      const leadingKey = leadingInstance ? await getInstanceComponentKey(leadingInstance) : null;
      if (requiredLeading && leadingKey !== requiredLeading.key) {
        problems.push("Leading is not on the new leading component (still using the old leading, or an unresolved one).");
      }
    }
    if (snapshot.heading !== null) {
      const headingProp = findProp(replacement, "heading");
      if (!headingProp || String(headingProp.value) !== snapshot.heading) problems.push("Heading text does not match source.");
    }
    if (snapshot.description !== null) {
      const descProp = findProp(replacement, "description");
      if (!descProp || String(descProp.value) !== snapshot.description) problems.push("Description text does not match source.");
    }
    return problems;
  }
  function buildReport(scopeLabel2, sourceCount, outcomes) {
    const migrated = outcomes.filter((o) => o.status === "migrated").length;
    const skipped = outcomes.filter((o) => o.status === "skipped" || o.status === "already-migrated").length;
    const failed = outcomes.filter((o) => o.status === "failed").length;
    const manualReview = outcomes.filter((o) => o.status === "manual-review").length;
    const exceptionLines = outcomes.filter((o) => o.status !== "migrated").map((o) => `- ${o.sourceNodeId}${o.replacementNodeId ? ` / ${o.replacementNodeId}` : ""} \u2014 ${o.status} \u2014 ${o.reason}`).join("\n");
    return [
      `Scope: ${scopeLabel2}`,
      `Source instances: ${sourceCount}`,
      `Migrated: ${migrated}`,
      `Skipped: ${skipped}`,
      `Failed: ${failed}`,
      `Manual review: ${manualReview}`,
      "",
      "Exceptions:",
      exceptionLines || "- none"
    ].join("\n");
  }
  function scopeLabel(scope) {
    if (scope.mode === "selection") return "current selection";
    if (scope.mode === "current-page") return `page "${figma.currentPage.name}"`;
    if (scope.mode === "all-pages") return "all pages";
    return `pages: ${(scope.pageNames || []).join(", ")}`;
  }
  async function captureReference(nodeId, role) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
    if (role === "old") {
      const r2 = await resolveOldReference(nodeId);
      resolution = {
        oldMainKey: r2.mainKey,
        oldMainName: r2.mainName,
        newMainKey: (_a = resolution == null ? void 0 : resolution.newMainKey) != null ? _a : "",
        newMainName: (_b = resolution == null ? void 0 : resolution.newMainName) != null ? _b : "",
        oldLeadingSetKey: r2.leadingSetKey,
        newLeadingTypeKeys: (_c = resolution == null ? void 0 : resolution.newLeadingTypeKeys) != null ? _c : {},
        newLeadingSetKey: (_d = resolution == null ? void 0 : resolution.newLeadingSetKey) != null ? _d : null,
        newActionKey: (_e = resolution == null ? void 0 : resolution.newActionKey) != null ? _e : null,
        diagnostics: r2.diagnostics
      };
      return;
    }
    const r = await resolveNewReference(nodeId, (_f = resolution == null ? void 0 : resolution.oldLeadingSetKey) != null ? _f : null);
    resolution = {
      oldMainKey: (_g = resolution == null ? void 0 : resolution.oldMainKey) != null ? _g : "",
      oldMainName: (_h = resolution == null ? void 0 : resolution.oldMainName) != null ? _h : "",
      newMainKey: r.mainKey,
      newMainName: r.mainName,
      oldLeadingSetKey: (_i = resolution == null ? void 0 : resolution.oldLeadingSetKey) != null ? _i : null,
      // Merge rather than replace — a verified auto-resolve fills in types
      // this reference confirms, but must not wipe out types already
      // confirmed by an earlier explicit "Capture as LEADING SET".
      newLeadingTypeKeys: __spreadValues(__spreadValues({}, (_j = resolution == null ? void 0 : resolution.newLeadingTypeKeys) != null ? _j : {}), r.leadingTypeKeys),
      newLeadingSetKey: (_l = (_k = r.leadingSetKey) != null ? _k : resolution == null ? void 0 : resolution.newLeadingSetKey) != null ? _l : null,
      newActionKey: r.actionKey,
      diagnostics: r.diagnostics
    };
  }
  figma.ui.onmessage = async (msg) => {
    try {
      if (msg.type === "find-components") {
        const candidates = await findComponentCandidates(msg.scope);
        const notes = [];
        for (const role of ["old", "new"]) {
          const matches = candidates.filter((c) => c.role === role);
          const label = role === "old" ? "gravity-list-entry" : "gravity-list-entry-new";
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
              `Found ${matches.length} different components named "${label}" \u2014 cannot pick automatically. Narrow your selection so only the correct one is included, then scan again.`
            );
          }
        }
        figma.ui.postMessage({ type: "find-results", candidates, notes, resolution });
        return;
      }
      if (msg.type === "migrate") {
        if (!resolution || !resolution.oldMainKey || !resolution.newMainKey) {
          throw new Error("Resolve both the old and new reference components before running.");
        }
        componentIndex = null;
        instanceIndexBuilt = false;
        const scope = msg.scope;
        const roots = await getScopeRoots(scope);
        const allInstances = await collectInstances(roots);
        const { migratable, alreadyMigrated } = await classifyInstances(allInstances, resolution);
        const snapshots = [];
        for (const inst of migratable) snapshots.push(await auditInstance(inst));
        const gate = gateCheck(snapshots, resolution);
        if (!gate.ok) {
          const parts = [];
          if (gate.missingLeadingTypes.length > 0) {
            parts.push(`leading type${gate.missingLeadingTypes.length === 1 ? "" : "s"} "${gate.missingLeadingTypes.join('", "')}"`);
          }
          if (gate.actionMissing) parts.push("the action component");
          figma.ui.postMessage({
            type: "error",
            message: `Could not resolve ${parts.join(" and ")} on gravity-list-entry-new. Halted before making any changes \u2014 make sure your selection includes an instance of gravity-list-entry-new that already uses ${parts.length > 1 ? "these" : "it"}, then scan and migrate again.`
          });
          return;
        }
        const outcomes = alreadyMigrated.map((inst) => ({
          sourceNodeId: inst.id,
          status: "already-migrated",
          reason: "Already on gravity-list-entry-new; skipped for idempotency."
        }));
        for (let i = 0; i < snapshots.length; i++) {
          const outcome = await migrateInstance(snapshots[i], resolution);
          outcomes.push(outcome);
          figma.ui.postMessage({ type: "progress", done: i + 1, total: snapshots.length });
        }
        const report = buildReport(scopeLabel(scope), migratable.length + alreadyMigrated.length, outcomes);
        const count = (...statuses) => outcomes.filter((o) => statuses.includes(o.status)).length;
        figma.ui.postMessage({
          type: "report",
          report,
          summary: {
            scope: scopeLabel(scope),
            source: migratable.length + alreadyMigrated.length,
            migrated: count("migrated"),
            skipped: count("skipped", "already-migrated"),
            failed: count("failed"),
            manualReview: count("manual-review")
          },
          exceptions: outcomes.filter((o) => o.status !== "migrated").map((o) => ({ id: o.sourceNodeId, replacementId: o.replacementNodeId, status: o.status, reason: o.reason }))
        });
        return;
      }
      if (msg.type === "get-selection-name") {
        const sel = figma.currentPage.selection[0];
        figma.ui.postMessage({ type: "selection-name", name: sel ? sel.name : null });
        return;
      }
    } catch (err) {
      figma.ui.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
})();

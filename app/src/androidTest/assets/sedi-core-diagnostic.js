// Synthetic Core SEDI instrumentation; uses the bundled FortWeb worker.
const coreContext = async () => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = typeof args[0] === "string" ? args[0] : args[0].url;
        if (url === "https://appassets.androidplatform.net/pyscript-ci.toml") {
            return {ok: response.ok, status: response.status,
                text: async () => "fort_synthetic_recipient_testing = true\n" + await response.text()};
        }
        return response;
    };
    const {createRuntimeBridge} = await import("https://appassets.androidplatform.net/app/runtime/bridge.js");
    const origin = window.__FORT_RUNTIME_ORIGIN__;
    const ctx = {};
    ctx.newBridge = () => createRuntimeBridge({workerUrl:new URL(origin.workerUrl),
        configUrl:new URL(origin.configUrl), runtimeOriginContract:origin});
    ctx.bridge = ctx.newBridge();
    ctx.request = (method, params = {}) => ctx.bridge.request(method, params, 180000);
    return ctx;
};
const coreHex = text => Array.from(new TextEncoder().encode(text), x => x.toString(16).padStart(2, "0")).join("");
const coreBytes = hex => Uint8Array.from(hex.match(/../g) ?? [], x => parseInt(x, 16));
const coreHash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    x => x.toString(16).padStart(2, "0")).join("");
const coreCanonical = value => value && typeof value === "object"
    ? Array.isArray(value) ? value.map(coreCanonical) : Object.fromEntries(
        Object.keys(value).sort().map(key => [key, coreCanonical(value[key])]))
    : value;
const coreRecords = async namespace => {
    const name = `IDBMap/@fortweb-v2/${namespace}`;
    if (!(await indexedDB.databases()).some(entry => entry.name === name))
        throw new Error("Expected synthetic storage is absent");
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onupgradeneeded = () => request.transaction.abort();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        const raw = await new Promise((resolve, reject) => {
            const request = db.transaction("entries", "readonly").objectStore("entries").get("__records__");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return JSON.parse(raw || "{}");
    } finally { db.close(); }
};
const coreSignedState = async storageName => {
    const wallet = {}, registry = {};
    for (const name of ["kels.", "evts.", "sigs.", "fwpn.", "fwrc."]) {
        const records = await coreRecords(`${storageName}:${name}`);
        wallet[name] = await coreHash(new TextEncoder().encode(JSON.stringify(coreCanonical(records))));
        if (name === "fwrc." && Object.prototype.hasOwnProperty.call(records, coreHex("_pending")))
            throw new Error("Pending receipt or presentation");
    }
    for (const name of ["regs.", "tels.", "evts.", "ancs.", "heds."]) {
        const records = await coreRecords(`acdc-reg:${storageName}:${name}`);
        registry[name] = await coreHash(new TextEncoder().encode(JSON.stringify(coreCanonical(records))));
        if (name === "regs." && Object.prototype.hasOwnProperty.call(records, coreHex("_fortweb_pending")))
            throw new Error("Pending registry operation");
    }
    return {wallet, registry};
};
const coreSnapshot = async (ctx, expected) => {
    if (!Array.isArray(expected.presentationTelSha256) ||
        expected.presentationTelSha256.length <= expected.binding.sequence || expected.nodeSaids.length !== 3)
        throw new Error("Core checkpoint evidence is incomplete");
    const request = ctx.request, vaultId = ctx.vaultId;
    const identifier = (await request("identifiers.get", {vaultId, aid:expected.holderAid})).identifier;
    const kel = (await request("identifiers.export", {vaultId, aid:expected.holderAid})).cesr;
    const credential = await request("credentials.getReceived", {vaultId, syntheticOnly:true, said:expected.credentialSaid});
    if (credential.credential.issuance !== "verified") throw new Error("Core credential is not verified");
    const registry = (await request("registries.get", {vaultId, name:"presentations"})).registry;
    const exchange = (await request("ipex.get", {vaultId, syntheticOnly:true, said:expected.grantSaid})).exchange;
    if (registry.registryId !== expected.registryId || exchange.said !== expected.grantSaid)
        throw new Error("Recovered registry or Grant differs");
    const bindingRecords = await coreRecords(`${ctx.storageName}:fwpn.`);
    const encodedBinding = bindingRecords[coreHex(expected.grantSaid)];
    if (!encodedBinding) throw new Error("Original presentation binding is missing");
    const binding = JSON.parse(new TextDecoder().decode(coreBytes(encodedBinding)));
    if (JSON.stringify(coreCanonical(binding)) !== JSON.stringify(coreCanonical(expected.binding)))
        throw new Error("Original presentation binding differs");
    const events = await coreRecords(`acdc-reg:${ctx.storageName}:evts.`);
    const eventHashes = await Promise.all(Object.values(events).map(value => coreHash(coreBytes(value))));
    if (expected.presentationTelSha256.some(hash => !eventHashes.includes(hash)))
        throw new Error("Original presentation TEL event is missing");
    const nested = await coreRecords(`${ctx.storageName}:enst.`);
    const prefix = coreHex(expected.grantSaid + ".");
    const streams = Object.keys(nested).filter(key => key.startsWith(prefix)).sort().map(key => coreBytes(nested[key]));
    if (streams.length !== expected.nodeSaids.length || expected.nodeSaids.some(said =>
        !streams.some(stream => new TextDecoder().decode(stream).includes(said))))
        throw new Error("Original Core authority streams are missing");
    return {holderAid:identifier.aid, holderSequence:identifier.sequenceNumber,
        holderHead:identifier.lastEventDigest,
        holderKelSha256:await coreHash(Uint8Array.from(atob(kel), c => c.charCodeAt(0))),
        credentialSaid:credential.credential.said,
        credentialEvidenceSha256:await coreHash(new TextEncoder().encode(JSON.stringify(coreCanonical(credential.evidence)))),
        registryId:registry.registryId, binding, presentationTelSha256:expected.presentationTelSha256, grant:exchange,
        nestedSha256:await Promise.all(streams.map(coreHash)), signedState:await coreSignedState(ctx.storageName)};
};
window.__sediCoreActions = {
    setup: async (runId) => {
    const ctx = await coreContext();
    const vault = await ctx.request("vaults.create", {
        name:"synthetic-core-holder-" + runId, passcode:"synthetic-holder-passcode"});
    ctx.vaultId = vault.vault.id;
    ctx.storageName = vault.vault.storageName;
    await ctx.request("vaults.open", {vaultId:ctx.vaultId, passcode:"synthetic-holder-passcode"});
    ctx.holderAid = (await ctx.request("identifiers.create", {vaultId:ctx.vaultId, alias:"holder"})).identifier.aid;
    ctx.registry = (await ctx.request("registries.create", {
        vaultId:ctx.vaultId, issuerAid:ctx.holderAid, name:"presentations"})).registry;
    globalThis.__coreSediTest = ctx;
    return JSON.stringify({holderAid:ctx.holderAid, registryId:ctx.registry.registryId});
    },
    prepare: async (fixtureJSON) => {
    let stage = "setup";
    try {
    const fixture = JSON.parse(fixtureJSON);
    const ctx = globalThis.__coreSediTest;
    const request = ctx.request;
    ctx.fixture = fixture;
    const vaultId = ctx.vaultId;
    stage = "core-schema";
    await request("schemas.import", {vaultId, schemaId:fixture.evidence.schemaId,
        schema:JSON.stringify(fixture.schema)});
    stage = "authority-schemas";
    for (const schema of fixture.authority_schemas) {
        await request("schemas.import", {vaultId, schemaId:schema.$id, schema:JSON.stringify(schema)});
    }
    stage = "remotes";
    for (const [index, evidence] of fixture.supporting.entries()) {
        await request("remotes.import", {vaultId, alias:"authority-" + index, cesr:evidence.kel});
    }
    await request("remotes.import", {vaultId, alias:"issuer", cesr:fixture.issuer});
    await request("remotes.import", {vaultId, alias:"verifier", cesr:fixture.verifierKel});
    stage = "receipt";
    const received = await request("credentials.receive", {vaultId, syntheticOnly:true,
        issuerAid:fixture.evidence.issuerAid, recipientAid:ctx.holderAid,
        schemaId:fixture.evidence.schemaId, evidence:fixture.evidence});
    if (received.credential.issuance !== "verified") throw new Error("Core receipt was not verified");
    ctx.params = {vaultId, syntheticOnly:true, credentialSaid:fixture.evidence.said,
        presenterAid:ctx.holderAid, verifierAid:fixture.verifierAid,
        message:"Present Core SEDI", presentationRegistry:"presentations",
        authorityEvidence:fixture.supporting,
        disclosurePlan:[[fixture.evidence.schemaId, "/", [""]],
            [fixture.supporting[0].schemaId, "/e/utahAgent/_/", [""]],
            [fixture.supporting[1].schemaId, "/e/utahAgent/_/e/orgUnit/_/", [""]]]};
    stage = "negative-preflight";
    const before = await request("identifiers.export", {vaultId, aid:ctx.holderAid});
    const registryBefore = await request("registries.get", {vaultId, name:"presentations"});
    const signedBefore = await coreSignedState(ctx.storageName);
    for (const invalid of [
        {authorityEvidence:fixture.supporting.slice(0, 1)},
        {authorityEvidence:fixture.supporting.slice(1)},
        {disclosurePlan:ctx.params.disclosurePlan.slice(0, 2)}
    ]) {
        let rejected = false;
        try { await request("ipex.present", {...ctx.params, ...invalid}); } catch (_) { rejected = true; }
        if (!rejected) throw new Error("Invalid Core presentation was accepted");
        const after = await request("identifiers.export", {vaultId, aid:ctx.holderAid});
        if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Rejected preflight changed holder KEL");
        const registryAfter = await request("registries.get", {vaultId, name:"presentations"});
        if (JSON.stringify(registryAfter) !== JSON.stringify(registryBefore))
            throw new Error("Rejected preflight changed the registry view");
        if (JSON.stringify(await coreSignedState(ctx.storageName)) !== JSON.stringify(signedBefore))
            throw new Error("Rejected preflight changed signed state or pending markers");
    }
    stage = "other-grant";
    ctx.other = await request("ipex.present", {...ctx.params, message:"Different Core Grant"});
    return JSON.stringify({invalidRejected:true, holderKelUnchanged:true, registryViewUnchanged:true,
        otherGrant:ctx.other.exchange.said});
    } catch (error) {
        return JSON.stringify({failureStage:stage, message:String(error?.message ?? error),
            code:String(error?.code ?? "")});
    }
    },
    present: async () => {
    const ctx = globalThis.__coreSediTest;
    ctx.result = await ctx.request("ipex.present", ctx.params);
    if (ctx.result.presentation.grantSaid !== ctx.result.exchange.said ||
        ctx.result.presentation.registryId !== ctx.registry.registryId)
        throw new Error("Core presentation binding does not match");
    ctx.result.otherPresentation = ctx.other.presentation;
    return JSON.stringify(ctx.result);
    },
    recover: async () => {
    const ctx = globalThis.__coreSediTest;
    await ctx.request("vaults.close", {vaultId:ctx.vaultId});
    ctx.bridge.destroy();
    ctx.bridge = ctx.newBridge();
    await ctx.request("vaults.open", {vaultId:ctx.vaultId, passcode:"synthetic-holder-passcode"});
    const received = await ctx.request("credentials.getReceived", {
        vaultId:ctx.vaultId, syntheticOnly:true, said:ctx.fixture.evidence.said});
    const canonical = value => value && typeof value === "object"
        ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(
            Object.keys(value).sort().map(key => [key, canonical(value[key])]))
        : value;
    if (JSON.stringify(canonical(received.evidence)) !== JSON.stringify(canonical(ctx.fixture.evidence)))
        throw new Error("Core credential evidence changed on worker restart");
    const exchange = await ctx.request("ipex.get", {
        vaultId:ctx.vaultId, syntheticOnly:true, said:ctx.result.exchange.said});
    if (exchange.exchange.said !== ctx.result.exchange.said) throw new Error("Grant metadata changed");
    const p = ctx.result.presentation;
    const expected = {vaultId:ctx.vaultId, storageName:ctx.storageName, holderAid:ctx.holderAid,
        credentialSaid:ctx.fixture.evidence.said, registryId:ctx.registry.registryId,
        grantSaid:ctx.result.exchange.said, nodeSaids:[ctx.fixture.evidence.said, ...ctx.fixture.supporting.map(item => item.said)],
        presentationTelSha256:await Promise.all(p.tel.map(t => coreHash(Uint8Array.from(atob(t), c => c.charCodeAt(0))))),
        binding:{registryId:p.registryId, sequence:p.sequence, blinder:p.blinder, event:p.event}};
    ctx.checkpoint = {expected, snapshot:await coreSnapshot(ctx, expected)};
    await ctx.request("vaults.close", {vaultId:ctx.vaultId});
    ctx.bridge.destroy();
    return JSON.stringify({credentialRecovered:true, bindingRecovered:true, grantMetadataRecovered:true});
    },
    checkpoint: async () => JSON.stringify(globalThis.__coreSediTest.checkpoint),
    resume: async (input) => {
    const checkpoint = JSON.parse(input), expected = checkpoint.expected;
    const ctx = await coreContext();
    ctx.vaultId = expected.vaultId;
    ctx.storageName = expected.storageName;
    const vaults = (await ctx.request("vaults.list")).vaults;
    if (!vaults.some(v => v.id === ctx.vaultId && v.storageName === ctx.storageName))
        throw new Error("Original synthetic vault is missing");
    await ctx.request("vaults.open", {vaultId:ctx.vaultId, passcode:"synthetic-holder-passcode"});
    try {
        const snapshot = await coreSnapshot(ctx, expected);
        if (JSON.stringify(coreCanonical(snapshot)) !== JSON.stringify(coreCanonical(checkpoint.snapshot)))
            throw new Error("Recovered Core state differs from checkpoint");
        let missingRejected = false;
        try { await ctx.request("credentials.getReceived", {vaultId:ctx.vaultId, syntheticOnly:true, said:expected.nodeSaids[1]}); }
        catch (error) { missingRejected = error?.code === "NOT_FOUND"; }
        if (!missingRejected) throw new Error("Missing credential did not fail closed");
        let mismatchRejected = false;
        try { await coreSnapshot(ctx, {...expected, binding:{...expected.binding, event:expected.grantSaid}}); }
        catch (error) { mismatchRejected = String(error?.message).includes("Original presentation binding differs"); }
        if (!mismatchRejected) throw new Error("Mismatched binding did not fail closed");
        if (JSON.stringify(coreCanonical(await coreSnapshot(ctx, expected))) !== JSON.stringify(coreCanonical(snapshot)))
            throw new Error("Rejected recovery checks changed retained state");
        return JSON.stringify({recovered:true, missingCredentialRejected:true, mismatchedBindingRejected:true, snapshot});
    } finally {
        await ctx.request("vaults.close", {vaultId:ctx.vaultId});
        ctx.bridge.destroy();
    }
    },
};
window.__sediCoreRun = (action, input) => {
    window.__sediCoreResult = null;
    window.__sediCoreActions[action](input).then(
        value => { window.__sediCoreResult = {ok:true, value}; },
        error => { window.__sediCoreResult = {ok:false, message:String(error?.message ?? error)}; }
    );
};

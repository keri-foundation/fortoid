import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app/src/androidTest/assets/sedi-core-diagnostic.js", import.meta.url), "utf8");
const storageName = "synthetic-vault";
const walletStores = ["kels.", "evts.", "sigs.", "fwpn.", "fwrc."];
const registryStores = ["regs.", "tels.", "evts.", "ancs.", "heds."];
const namespace = name => `IDBMap/@fortweb-v2/${name}`;
const hex = text => Buffer.from(text).toString("hex");

function fixture() {
    const stores = new Map([
        ...walletStores.map(name => [namespace(`${storageName}:${name}`), {}]),
        ...registryStores.map(name => [namespace(`acdc-reg:${storageName}:${name}`), {}]),
    ]);
    const modes = [];
    const indexedDB = {
        databases: async () => [...stores.keys()].map(name => ({name})),
        open(name) {
            assert.ok(stores.has(name), "must never create missing storage");
            const request = {};
            queueMicrotask(() => {
                request.result = {
                    close() {},
                    transaction(store, mode) {
                        assert.equal(store, "entries");
                        modes.push(mode);
                        return {objectStore: () => ({get(key) {
                            assert.equal(key, "__records__");
                            const read = {};
                            queueMicrotask(() => { read.result = JSON.stringify(stores.get(name)); read.onsuccess(); });
                            return read;
                        }})};
                    },
                };
                request.onsuccess();
            });
            return request;
        },
    };
    const context = vm.createContext({window:{}, indexedDB, crypto:webcrypto, TextEncoder, TextDecoder, Uint8Array});
    vm.runInContext(source, context);
    return {stores, modes, signedState:vm.runInContext("coreSignedState", context)};
}

test("Core signed-state probe opens only existing stores in read-only transactions", async () => {
    const f = fixture();
    const snapshot = await f.signedState(storageName);
    assert.equal(Object.keys(snapshot.wallet).length, walletStores.length);
    assert.equal(Object.keys(snapshot.registry).length, registryStores.length);
    assert.ok(f.modes.every(mode => mode === "readonly"));
    f.stores.delete(namespace(`${storageName}:kels.`));
    await assert.rejects(f.signedState(storageName), /storage is absent/);
});

for (const [name, marker, message] of [
    [`${storageName}:fwrc.`, "_pending", /Pending receipt or presentation/],
    [`acdc-reg:${storageName}:regs.`, "_fortweb_pending", /Pending registry operation/],
]) {
    test(`Core signed-state probe rejects an empty pending marker in ${name}`, async () => {
        const f = fixture();
        f.stores.get(namespace(name))[hex(marker)] = "";
        await assert.rejects(f.signedState(storageName), message);
    });
}

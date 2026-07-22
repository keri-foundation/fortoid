/**
 * Deterministic mock data for fixture routes.
 * Used by screenshot automation to reach every screen state
 * without a running wallet runtime.
 */
const FIXTURE_VAULT_ID = "fixture-vault-001";
const FIXTURE_AID = "EKYGGh-FtAphGmSZbsuBs_t4qpsjYJ2ZqvMKluq9OxmP";
const FIXTURE_REMOTE_AID = "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao";
export const fixtureVault = {
    id: FIXTURE_VAULT_ID,
    alias: "Demo Vault",
    storageName: "IndexedDB",
    createdAt: "2026-04-01T12:00:00Z",
    otpConfigured: false,
    locked: false,
    identifierCount: 3,
    remoteCount: 5,
};
export const fixtureVaultLocked = {
    ...fixtureVault,
    locked: true,
};
export const fixtureVaults = [
    fixtureVault,
    {
        id: "fixture-vault-002",
        alias: "Work Vault",
        storageName: "IndexedDB",
        createdAt: "2026-03-15T09:30:00Z",
        otpConfigured: true,
        locked: true,
        identifierCount: 1,
        remoteCount: 2,
    },
];
export const fixtureIdentifiers = [
    {
        aid: FIXTURE_AID,
        alias: "primary-aid",
        prefix: FIXTURE_AID,
        sequenceNumber: 4,
        witnessSummary: "3/3 connected",
        lastEventDigest: "EMkPcg-L4G-fcKwAuUPxoh8RpjGrNfHmSLc3bMN0r5hO",
        status: "Established",
        statusTone: "success",
        kelEvents: 5,
        witnessCount: 3,
        oobi: "http://127.0.0.1:5642/oobi/EKYGGh-FtAphGmSZbsuBs_t4qpsjYJ2ZqvMKluq9OxmP/witness",
        witnesses: [
            { alias: "wan-witness-0", status: "connected", statusTone: "success" },
            { alias: "wan-witness-1", status: "connected", statusTone: "success" },
            { alias: "wan-witness-2", status: "connected", statusTone: "success" },
        ],
    },
    {
        aid: "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao",
        alias: "backup-aid",
        prefix: "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao",
        sequenceNumber: 1,
        witnessSummary: "3/3 connected",
        lastEventDigest: "EQNojhJ_jKKat-1dK-ld8J7YO5IUkz-yOV7h3BiflmNw",
        status: "Established",
        statusTone: "success",
        kelEvents: 2,
        witnessCount: 3,
        oobi: "http://127.0.0.1:5642/oobi/EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao/witness",
        witnesses: [
            { alias: "wan-witness-0", status: "connected", statusTone: "success" },
            { alias: "wan-witness-1", status: "connected", statusTone: "success" },
            { alias: "wan-witness-2", status: "pending", statusTone: "warning" },
        ],
    },
];
export const fixtureRemotes = [
    {
        aid: FIXTURE_REMOTE_AID,
        alias: "acme-corp",
        prefix: FIXTURE_REMOTE_AID,
        sequenceNumber: 2,
        transferable: true,
        transferability: "Transferable",
        rolesLabel: "witness, watcher",
        status: "Verified",
        statusTone: "success",
        org: "ACME Corporation",
        company: "ACME Corp",
        note: "Main trading partner",
        oobi: "http://127.0.0.1:5643/oobi/EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao",
        lastEventDigest: "EJkz-hGTAphGmSZbsuBs_t4qpsjYJ2ZqvMKluq9OxmP",
        keystateUpdatedAt: "2026-04-10T14:22:00Z",
        verificationCount: 3,
        kelEvents: 3,
        mailboxes: ["http://127.0.0.1:5644/mailbox"],
        roles: ["witness", "watcher"],
    },
];
export const fixtureSettings = {
    tempDatastore: false,
    storageBackend: "Browser IndexedDB via WebBaser and WebKeeper",
    keyAlgorithm: "salty",
    keyTier: "low",
    witnessProfile: "Direct",
    runtimeStatus: "Ready",
};
export const fixtureBootstrapDisconnected = {
    bootUrl: "http://127.0.0.1:9723",
    connection: { ok: false, error: "Disconnected" },
    witnesses: [],
};
export const fixtureBootstrapConnected = {
    bootUrl: "http://127.0.0.1:9723",
    connection: { ok: true },
    account: {
        accountAid: "EAccountAid123456789",
        accountAlias: "KF Account",
    },
    witnesses: [
        { alias: "wan-0", url: "http://127.0.0.1:5642", status: "connected", statusTone: "success" },
    ],
};
export const fixtureBootstrapOnboarded = {
    bootUrl: "http://127.0.0.1:9723",
    connection: { ok: true },
    account: {
        status: "onboarded",
        accountAid: "EAccountAid123456789",
        accountAlias: "KF Account",
        witnessProfileCode: "direct",
        witnessCount: 3,
        toad: 2,
    },
    bootstrap: {
        accountOptions: [
            { code: "direct", witnessCount: 3, toad: 2 },
        ],
    },
    witnesses: [
        { alias: "wan-0", url: "http://127.0.0.1:5642", status: "connected", statusTone: "success" },
        { alias: "wan-1", url: "http://127.0.0.1:5643", status: "connected", statusTone: "success" },
    ],
};
export const fixtureWitnesses = [
    { name: "KF Witness wan-0", url: "http://127.0.0.1:5642", status: "connected", statusTone: "success", eid: "EWitness0" },
    { name: "KF Witness wan-1", url: "http://127.0.0.1:5643", status: "connected", statusTone: "success", eid: "EWitness1" },
];
export const fixtureWatchers = [
    { alias: "watcher-0", url: "http://127.0.0.1:5645", status: "connected", statusTone: "success", eid: "EWatcher0" },
];
export const FIXTURE_VAULT_ID_CONST = FIXTURE_VAULT_ID;

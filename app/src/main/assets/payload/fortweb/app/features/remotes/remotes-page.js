import { remoteDetailHref } from "../../app/router.js";
import { renderPaginatedTable } from "../../shared/components.js";
import { escapeHtml } from "../../shared/dom.js";
import { createModal } from "../../ui/composites/modal.js";
import { showToast } from "../../ui/composites/toast.js";
import { fieldTextHtml } from "../../ui/primitives/field-text.js";
import { chipHtml } from "../../ui/primitives/chip.js";
function queryInput(root, selector) {
    return root.querySelector(selector);
}
function queryButton(root, selector) {
    return root.querySelector(selector);
}
function queryElement(root, selector) {
    return root.querySelector(selector);
}
function errorMessage(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback;
}
function createResolveRemoteDialog(onResolveRemote) {
    const modal = createModal({
        title: "Add Remote Identifier",
        body: `
            <form data-resolve-remote-form>
                ${fieldTextHtml({ id: "resolve-oobi-url", label: "Blind OOBI URL", placeholder: "https://...", required: true })}
                ${fieldTextHtml({ id: "resolve-alias", label: "Alias", placeholder: "e.g. remote-peer" })}
                <p class="muted">Blind OOBI connect is the only enabled add path in this slice. File import remains deferred.</p>
                <p class="status-line" data-resolve-remote-status></p>
            </form>
        `,
        actions: [
            { label: "Cancel", tone: "ghost", dataAction: "cancel" },
            { label: "Resolve OOBI", tone: "primary", dataAction: "submit" },
        ],
    });
    modal.open();
    const root = document.querySelector("[role='dialog'][aria-label='Add Remote Identifier']");
    if (!(root instanceof HTMLElement)) {
        return;
    }
    const form = root.querySelector("[data-resolve-remote-form]");
    const statusLine = queryElement(root, "[data-resolve-remote-status]");
    const submitBtn = queryButton(root, "[data-action='submit']");
    const cancelBtn = queryButton(root, "[data-action='cancel']");
    if (!(form instanceof HTMLFormElement) || !statusLine || !submitBtn) {
        return;
    }
    cancelBtn?.addEventListener("click", () => modal.close());
    async function submit() {
        const oobiUrl = queryInput(form, "#resolve-oobi-url")?.value.trim() || "";
        const alias = queryInput(form, "#resolve-alias")?.value.trim() || "";
        if (!oobiUrl) {
            statusLine.textContent = "OOBI URL is required.";
            return;
        }
        submitBtn.disabled = true;
        statusLine.textContent = "";
        try {
            await onResolveRemote(oobiUrl, alias);
            modal.close();
            showToast({ message: "Remote identifier resolved.", tone: "success" });
        }
        catch (error) {
            submitBtn.disabled = false;
            statusLine.textContent = errorMessage(error, "OOBI resolution failed.");
        }
    }
    submitBtn.addEventListener("click", () => {
        void submit();
    });
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        void submit();
    });
}
function createRemoteEditDialog(remote, onUpdateRemote) {
    const modal = createModal({
        title: `Edit ${remote.alias}`,
        body: `
            <form data-edit-remote-form>
                ${fieldTextHtml({ id: "edit-alias", label: "Alias", value: remote.alias ?? "" })}
                ${fieldTextHtml({ id: "edit-org", label: "Organization", value: remote.org ?? "" })}
                ${fieldTextHtml({ id: "edit-note", label: "Note", value: remote.note ?? "" })}
                <p class="status-line" data-edit-remote-status></p>
            </form>
        `,
        actions: [
            { label: "Cancel", tone: "ghost", dataAction: "cancel" },
            { label: "Save", tone: "primary", dataAction: "submit" },
        ],
    });
    modal.open();
    const root = Array.from(document.querySelectorAll("[role='dialog']")).find((el) => el.getAttribute("aria-label") === `Edit ${remote.alias}`);
    if (!(root instanceof HTMLElement)) {
        return;
    }
    const form = root.querySelector("[data-edit-remote-form]");
    const statusLine = queryElement(root, "[data-edit-remote-status]");
    const submitBtn = queryButton(root, "[data-action='submit']");
    const cancelBtn = queryButton(root, "[data-action='cancel']");
    if (!(form instanceof HTMLFormElement) || !statusLine || !submitBtn) {
        return;
    }
    cancelBtn?.addEventListener("click", () => modal.close());
    async function submit() {
        submitBtn.disabled = true;
        statusLine.textContent = "";
        try {
            await onUpdateRemote(remote.aid, {
                alias: queryInput(form, "#edit-alias")?.value.trim() || "",
                org: queryInput(form, "#edit-org")?.value.trim() || "",
                note: queryInput(form, "#edit-note")?.value.trim() || "",
            });
            modal.close();
            showToast({ message: `Remote "${remote.alias}" updated.`, tone: "success" });
        }
        catch (error) {
            submitBtn.disabled = false;
            statusLine.textContent = errorMessage(error, "Remote update failed.");
        }
    }
    submitBtn.addEventListener("click", () => {
        void submit();
    });
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        void submit();
    });
}
function applyRemoteFilter(remotes, filter) {
    if (filter === "transferable") {
        return remotes.filter((remote) => remote.transferable);
    }
    if (filter === "non-transferable") {
        return remotes.filter((remote) => !remote.transferable);
    }
    return remotes;
}
export function renderRemotesPage({ vault, remotes, filter, onResolveRemote, onUpdateRemote, onFilterChange, }) {
    const filteredRemotes = applyRemoteFilter(remotes, filter);
    const remoteRows = filteredRemotes.map((remote) => ({
        alias: remote.alias,
        aliasLink: `<a href="${remoteDetailHref(vault.id, remote.aid)}">${escapeHtml(remote.alias)}</a>`,
        prefix: remote.prefix,
        sequenceNumber: remote.sequenceNumber == null ? "Not resolved" : String(remote.sequenceNumber),
        transferability: remote.transferability,
        rolesLabel: remote.rolesLabel,
        status: remote.status,
        _raw: remote,
    }));
    const filterChipsHtml = `
        <div class="lk-inline-filter" role="group" aria-label="Remote identifier filter">
            ${chipHtml({ label: "All", selected: filter === "all", dataValue: "all" })}
            ${chipHtml({ label: "Transferable", selected: filter === "transferable", dataValue: "transferable" })}
            ${chipHtml({ label: "Non-transferable", selected: filter === "non-transferable", dataValue: "non-transferable" })}
        </div>
        <p class="lk-table-header__note">Connect by blind OOBI only. File import remains deferred in this slice.</p>
    `;
    const columns = [
        { key: "aliasLink", label: "Alias", width: "210px", searchKey: "alias", html: true },
        { key: "prefix", label: "Prefix", width: "320px" },
        { key: "sequenceNumber", label: "Seq No.", width: "110px" },
        { key: "transferability", label: "Type", width: "150px" },
        { key: "rolesLabel", label: "Roles", width: "180px" },
        { key: "status", label: "Status", width: "110px" },
    ];
    const remotesTable = renderPaginatedTable({
        icon: "./assets/icons/remoteIds.png",
        title: "Remote Identifiers",
        collapseHeadingOnMobile: true,
        titleMetaHtml: filterChipsHtml,
        searchPlaceholder: "Search...",
        addButtonText: "Add Remote Identifier",
        columns,
        rows: remoteRows,
        rowActions: [
            { key: "view", label: "View", icon: "./assets/icons/browse.svg" },
            { key: "edit", label: "Edit", icon: "./assets/icons/edit.svg" },
        ],
        itemsPerPage: 10,
        emptyTitle: "No Remote Identifiers Yet",
        emptyText: "Add a remote identifier by resolving a blind OOBI from this route.",
        onAdd() {
            createResolveRemoteDialog(onResolveRemote);
        },
        onAction(row, actionKey) {
            if (actionKey === "view") {
                window.location.hash = remoteDetailHref(vault.id, row._raw.aid);
                return;
            }
            if (actionKey === "edit") {
                createRemoteEditDialog(row._raw, onUpdateRemote);
            }
        },
    });
    return {
        title: "Remote Identifiers",
        render(container) {
            container.replaceChildren();
            const page = document.createElement("section");
            page.className = "page-grid page-grid--table";
            const section = document.createElement("section");
            section.className = "section-card section-card--tight page-table-stage";
            const tableRoot = document.createElement("div");
            tableRoot.dataset.remotesTable = "true";
            tableRoot.innerHTML = remotesTable.html;
            section.append(tableRoot);
            page.append(section);
            container.append(page);
        },
        setup(root) {
            remotesTable.setup(queryElement(root, "[data-remotes-table]"));
            root.querySelectorAll("[data-value]").forEach((button) => {
                if (!(button instanceof HTMLElement)) {
                    return;
                }
                button.addEventListener("click", () => {
                    const nextFilter = button.dataset.value || "all";
                    if (nextFilter !== filter) {
                        onFilterChange(nextFilter);
                    }
                });
            });
        },
    };
}

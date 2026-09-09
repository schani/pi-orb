import { UPLOAD_CHUNK_BYTES, type UploadBatch, type WorkspaceUpload } from "@pi-orb/protocol";
import { Result } from "neverthrow";
import { useEffect, useRef, useState } from "react";
import {
  beginWorkspaceUploadBatch,
  describeApiError,
  listWorkspaceUploads,
  workspaceUploadAction,
} from "../lib/api.ts";
import { generateUuid } from "../lib/uuid.ts";
import { Icon } from "./Icons.tsx";

type LocalFile = {
  batch: UploadBatch;
  id: string;
  file: File | null;
  name: string;
  size: number;
  progress: WorkspaceUpload | null;
  error: string | null;
  active: boolean;
};
const finished = (row: WorkspaceUpload | null) =>
  row?.status === "notified" || row?.status === "cancelled";

export function useWorkspaceUploads(orbId: string, running: boolean) {
  const picker = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const batches = useRef(
    new Map<
      string,
      { request: ReturnType<typeof beginWorkspaceUploadBatch>; controller: AbortController }
    >(),
  );
  const mounted = useRef(true);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [remote, setRemote] = useState<WorkspaceUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current.values()) controller.abort();
      for (const batch of batches.current.values()) batch.controller.abort();
    };
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const result = await listWorkspaceUploads(orbId);
      if (!active) return;
      if (result.isOk()) {
        setLoadError(null);
        setRemote(result.value);
        // Polling may reconcile a lost finish response. Completed local rows
        // remain tombstones so an older poll cannot resurrect their progress.
        setFiles((old) =>
          old.map((item) => {
            const row = result.value.find((candidate) => candidate.id === item.id);
            return row &&
              (finished(row) || row.status === "stored") &&
              !item.active &&
              !finished(item.progress)
              ? { ...item, progress: row, error: null, file: null }
              : item;
          }),
        );
      } else setLoadError(describeApiError(result.error));
      timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [orbId]);
  const update = (id: string, patch: Partial<LocalFile>) => {
    if (mounted.current)
      setFiles((old) => old.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };
  const start = async (item: LocalFile) => {
    if (!running || !item.file || controllers.current.has(item.id)) return;
    const file = item.file;
    const abort = new AbortController();
    controllers.current.set(item.id, abort);
    update(item.id, { active: true, error: null });
    let preparation = batches.current.get(item.batch.id);
    if (!preparation) {
      const controller = new AbortController();
      preparation = {
        controller,
        request: beginWorkspaceUploadBatch(orbId, item.batch, controller.signal),
      };
      batches.current.set(item.batch.id, preparation);
    }
    const created = await preparation.request;
    const admitted = created.isOk() ? created.value.find((row) => row.id === item.id) : undefined;
    if (!admitted || abort.signal.aborted) {
      if (created.isErr() && batches.current.get(item.batch.id) === preparation)
        batches.current.delete(item.batch.id);
      update(item.id, {
        active: false,
        ...(admitted ? { progress: admitted } : {}),
        error: abort.signal.aborted
          ? "Transfer paused."
          : created.isErr()
            ? describeApiError(created.error)
            : "Upload missing from batch response",
      });
      controllers.current.delete(item.id);
      return;
    }
    update(item.id, { progress: admitted });
    let result = await workspaceUploadAction(orbId, item.id, "status", abort.signal);
    while (
      result.isOk() &&
      result.value.offset < file.size &&
      result.value.path === null &&
      !finished(result.value) &&
      !abort.signal.aborted
    ) {
      const offset = result.value.offset;
      update(item.id, { progress: result.value });
      result = await workspaceUploadAction(orbId, item.id, "chunk", abort.signal, {
        body: file.slice(offset, offset + UPLOAD_CHUNK_BYTES),
        offset,
      });
    }
    if (result.isOk() && !finished(result.value) && !abort.signal.aborted) {
      update(item.id, {
        progress: {
          ...result.value,
          status: result.value.path === null ? "finalizing" : result.value.status,
        },
      });
      result = await workspaceUploadAction(orbId, item.id, "finish", abort.signal);
    }
    if (result.isErr())
      update(item.id, {
        active: false,
        error: abort.signal.aborted ? "Transfer paused." : describeApiError(result.error),
      });
    else
      update(item.id, {
        active: false,
        progress: result.value,
        ...(finished(result.value) ? { file: null } : {}),
      });
    controllers.current.delete(item.id);
  };
  const cancel = async (id: string) => {
    const result = await workspaceUploadAction(orbId, id, "cancel", new AbortController().signal);
    if (!mounted.current) return;
    if (result.isErr()) {
      setError(describeApiError(result.error));
      return;
    }
    update(id, { progress: result.value, error: null, file: null });
    setRemote((old) => old.map((row) => (row.id === id ? result.value : row)));
  };
  const status = (row: WorkspaceUpload) =>
    row.status === "stored"
      ? "stored · notification pending"
      : row.status === "finalizing"
        ? "finalizing"
        : `${row.offset.toLocaleString()} / ${row.size.toLocaleString()} B`;
  const localIds = new Set(files.map((item) => item.id));
  const visibleLocal = files.filter((item) => !finished(item.progress));
  const visibleRemote = remote.filter((row) => !localIds.has(row.id) && !finished(row));
  const button = running ? (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label="Upload files"
        title="upload files"
        onClick={() => picker.current?.click()}
      >
        <Icon name="upload" />
      </button>
      <input
        ref={picker}
        aria-label="Files to upload"
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const added: LocalFile[] = [];
          const batch: UploadBatch = { id: "", files: [] };
          for (const file of Array.from(event.target.files ?? [])) {
            const id = Result.fromThrowable(generateUuid, () => ({
              type: "browser_crypto" as const,
              message: "Cannot create upload identity",
            }))();
            if (id.isErr()) {
              setError(id.error.message);
              event.target.value = "";
              return;
            }
            added.push({
              id: id.value,
              batch,
              file,
              name: file.name,
              size: file.size,
              progress: null,
              error: null,
              active: true,
            });
          }
          event.target.value = "";
          if (!added.length) return;
          batch.id = added[0]?.id ?? "";
          batch.files = added.map(({ id, name, size }) => ({ id, name, size }));
          setError(null);
          setFiles((old) => [...old, ...added]);
          for (const item of added) void start(item);
        }}
      />
    </>
  ) : null;
  const progress =
    visibleLocal.length || visibleRemote.length || error || loadError ? (
      <section className="workspace-uploads" aria-label="File transfers" aria-live="polite">
        {visibleLocal.map((item) => (
          <div className="workspace-upload-row" key={item.id}>
            <span>{item.progress?.path ?? item.name}</span>
            <span className="muted">
              {item.progress ? status(item.progress) : `0 / ${item.size.toLocaleString()} B`}
            </span>
            {(item.error || item.progress?.error) && (
              <span className="error-text">{item.error ?? item.progress?.error}</span>
            )}
            <span className="workspace-upload-actions">
              {item.active ? (
                <button
                  type="button"
                  className="text-action"
                  onClick={() => controllers.current.get(item.id)?.abort()}
                >
                  pause
                </button>
              ) : (
                <>
                  {running && item.file && item.progress?.status !== "stored" && (
                    <button type="button" className="text-action" onClick={() => void start(item)}>
                      retry
                    </button>
                  )}
                  {item.progress?.status !== "stored" && (
                    <button
                      type="button"
                      className="text-action"
                      disabled={!running && item.progress !== null}
                      onClick={() =>
                        item.progress
                          ? void cancel(item.id)
                          : setFiles((old) => old.filter((row) => row.id !== item.id))
                      }
                    >
                      {item.progress ? "cancel" : "dismiss"}
                    </button>
                  )}
                </>
              )}
            </span>
          </div>
        ))}
        {visibleRemote.map((row) => (
          <div className="workspace-upload-row" key={row.id}>
            <span>{row.path ?? row.name}</span>
            <span className="muted">{status(row)}</span>
            {row.error && <span className="error-text">{row.error}</span>}
            {running && row.status !== "stored" && (
              <button type="button" className="text-action" onClick={() => void cancel(row.id)}>
                cancel
              </button>
            )}
          </div>
        ))}
        {(error || loadError) && (
          <div className="workspace-upload-row">
            <span className="error-text" role="alert">
              {error ?? loadError}
            </span>
            <button
              type="button"
              className="text-action"
              onClick={() => {
                setError(null);
                setLoadError(null);
              }}
            >
              dismiss
            </button>
          </div>
        )}
      </section>
    ) : null;
  return { button, progress };
}

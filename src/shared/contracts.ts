export type Side = 'left' | 'right';
export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'gb18030';
export type TargetStatus = 'pending' | 'saving' | 'saved' | 'conflict' | 'error' | 'rejected';
export interface SaveReceipt {
  operationId: string; targetPath: string; backupPath?: string;
  beforeHash: string | null; afterHash: string; savedAt: string; side: Side;
}
export interface TargetView {
  id: string; path: string; encoding: TextEncoding; bom: boolean; exists: boolean;
  baseHash: string | null; status: TargetStatus; error?: string; receipt?: SaveReceipt;
}
export interface PaneView { text: string; revision: number; targetId: string | null; }
export interface ReviewView {
  id: string; title: string; mode: 'single' | 'pair' | 'proposal' | 'text';
  closedAt?: string;
  createdAt: string; updatedAt: string; left: PaneView; right: PaneView; targets: TargetView[];
}
export interface WorkspaceView { reviews: ReviewView[]; }
export interface BaselineRequest { paths: string[]; encoding?: TextEncoding; }
export interface BaselineFile {
  id: string; path: string; sha256: string | null; exists: boolean;
  text: string; encoding: TextEncoding; bom: boolean;
}
export interface BaselineResponse { files: BaselineFile[]; }
export interface SubmitRequest {
  requestId: string; title?: string; files: { baselineId: string; text: string }[];
}
export interface SubmitResponse { reviewIds: string[]; duplicate: boolean; }
export interface OpenFilesRequest {
  paths: string[]; mode: 'single' | 'pair'; encoding?: TextEncoding;
}
export interface UpdateDraftRequest {
  reviewId: string; side: Side; text: string; expectedRevision: number;
}
export interface PrepareSaveRequest {
  reviewId: string; side: Side; expectedRevision: number; encoding?: TextEncoding;
  newPath?: string;
}
export interface SavePreview {
  token: string; reviewId: string; side: Side; revision: number;
  targetPath: string; backupPath?: string; isNew: boolean; encoding: TextEncoding;
  beforeHash: string | null; afterHash: string;
}
export interface ReviewStatus {
  id: string; title: string; targets: TargetView[]; leftRevision: number; rightRevision: number;
  lifecycle?: 'open' | 'closed' | 'deleted';
}
export interface StatusResponse { reviews: ReviewStatus[]; }
export interface WaitRequest { reviewIds: string[]; timeoutMs: number; }
export interface WaitResponse extends StatusResponse { reason: 'saved' | 'attention' | 'timeout'; }
export const DEFAULT_WAIT_MS = 30 * 60 * 1000;
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export type CliRequest =
  | { command: 'baseline'; payload: BaselineRequest }
  | { command: 'submit'; payload: SubmitRequest }
  | { command: 'status'; payload: { reviewId?: string } }
  | { command: 'wait'; payload: WaitRequest };
export type WireReply = { ok: true; result: unknown } | { ok: false; error: string; code?: string };
export interface AppSettings { closeToTray: boolean; }
export interface DesktopAPI {
  getSettings(): Promise<AppSettings>;
  setSettings(settings: AppSettings): Promise<AppSettings>;
  list(): Promise<WorkspaceView>;
  pickFiles(mode: 'single' | 'pair', encoding?: TextEncoding): Promise<WorkspaceView>;
  openFiles(request: OpenFilesRequest): Promise<WorkspaceView>;
  createTextReview(): Promise<ReviewView>;
  setReviewClosed(reviewId: string, closed: boolean): Promise<void>;
  deleteReview(reviewId: string): Promise<void>;
  deleteClosedReviews(reviewIds: string[]): Promise<string[]>;
  updateDraft(request: UpdateDraftRequest): Promise<ReviewView>;
  prepareSave(request: PrepareSaveRequest): Promise<SavePreview | null>;
  commitSave(token: string): Promise<SaveReceipt>;
  continueTarget(reviewId: string, targetId: string): Promise<ReviewView>;
  rejectReview(reviewId: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  getFilePath(file: File): string;
  onChanged(callback: () => void): () => void;
  onSaveShortcut(callback: () => void): () => void;
  readyToClose(): void;
  onBeforeClose(callback: () => void): () => void;
}
declare global { interface Window { diffEditor: DesktopAPI; } }

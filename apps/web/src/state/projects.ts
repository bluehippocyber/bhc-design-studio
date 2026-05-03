// Project / conversation / message / tab persistence — backed by the
// daemon's SQLite store. All writes round-trip through HTTP so projects
// stay coherent across multiple browser tabs and across restarts.
//
// When the daemon is unavailable (Vercel-hosted / API-only mode) every
// function falls back to localStorage so the UI stays fully functional.

import type {
  ChatMessage,
  Conversation,
  OpenTabsState,
  Project,
  ProjectMetadata,
  ProjectTemplate,
} from '../types';

// ── localStorage fallback store ──────────────────────────────────────────────

const LS_PROJECTS_KEY = 'bhc-ls-projects';
const LS_CONVERSATIONS_KEY = 'bhc-ls-conversations';
const LS_MESSAGES_KEY = 'bhc-ls-messages';
const LS_TABS_KEY = 'bhc-ls-tabs';

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage quota exceeded — best effort
  }
}

function lsGetProjects(): Project[] {
  return lsGet<Project[]>(LS_PROJECTS_KEY, []);
}

function lsSetProjects(projects: Project[]): void {
  lsSet(LS_PROJECTS_KEY, projects);
}

function lsGetConversations(): Conversation[] {
  return lsGet<Conversation[]>(LS_CONVERSATIONS_KEY, []);
}

function lsSetConversations(convos: Conversation[]): void {
  lsSet(LS_CONVERSATIONS_KEY, convos);
}

function lsGetMessages(): Record<string, ChatMessage[]> {
  return lsGet<Record<string, ChatMessage[]>>(LS_MESSAGES_KEY, {});
}

function lsSetMessages(messages: Record<string, ChatMessage[]>): void {
  lsSet(LS_MESSAGES_KEY, messages);
}

// ── helper: is the response a real JSON API response (not our SPA shell)? ────
// The catch-all rewrite may serve index.html for unknown paths — guard by
// checking Content-Type before trying to parse as JSON.
async function safeJson<T>(resp: Response): Promise<T | null> {
  const ct = resp.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return null;
  try {
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

// ── projects ──────────────────────────────────────────────────────────────────

export async function listProjects(): Promise<Project[]> {
  try {
    const resp = await fetch('/api/projects');
    if (resp.ok) {
      const json = await safeJson<{ projects: Project[] }>(resp);
      if (json) return json.projects ?? [];
    }
  } catch { /* fall through */ }
  return lsGetProjects();
}

export async function getProject(id: string): Promise<Project | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`);
    if (resp.ok) {
      const json = await safeJson<{ project: Project }>(resp);
      if (json) return json.project;
    }
  } catch { /* fall through */ }
  return lsGetProjects().find((p) => p.id === id) ?? null;
}

export async function createProject(input: {
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
}): Promise<{ project: Project; conversationId: string } | null> {
  const id = crypto.randomUUID();
  try {
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...input }),
    });
    if (resp.ok) {
      const json = await safeJson<{ project: Project; conversationId: string }>(resp);
      if (json) return json;
    }
  } catch { /* fall through */ }

  // ── localStorage fallback ────────────────────────────────────────────────
  const now = Date.now();
  const conversationId = crypto.randomUUID();
  const project: Project = {
    id,
    name: input.name.trim() || 'Untitled',
    skillId: input.skillId,
    designSystemId: input.designSystemId,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata,
    pendingPrompt: input.pendingPrompt,
  };

  const projects = lsGetProjects();
  lsSetProjects([project, ...projects.filter((p) => p.id !== project.id)]);

  // Seed an empty conversation so the project view can attach to it
  const conversation: Conversation = {
    id: conversationId,
    projectId: id,
    title: null,
    createdAt: now,
    updatedAt: now,
  };
  const convos = lsGetConversations();
  lsSetConversations([conversation, ...convos]);

  return { project, conversationId };
}

export async function importClaudeDesignZip(
  file: File,
): Promise<{ project: Project; conversationId: string; entryFile: string } | null> {
  try {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch('/api/import/claude-design', {
      method: 'POST',
      body: form,
    });
    if (resp.ok) {
      const json = await safeJson<{ project: Project; conversationId: string; entryFile: string }>(resp);
      if (json) return json;
    }
  } catch { /* fall through */ }
  return null;
}

// ---------- templates ----------

export async function listTemplates(): Promise<ProjectTemplate[]> {
  try {
    const resp = await fetch('/api/templates');
    if (resp.ok) {
      const json = await safeJson<{ templates: ProjectTemplate[] }>(resp);
      if (json) return json.templates ?? [];
    }
  } catch { /* fall through */ }
  return [];
}

export async function getTemplate(id: string): Promise<ProjectTemplate | null> {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(id)}`);
    if (resp.ok) {
      const json = await safeJson<{ template: ProjectTemplate }>(resp);
      if (json) return json.template;
    }
  } catch { /* fall through */ }
  return null;
}

export async function saveTemplate(input: {
  name: string;
  description?: string;
  sourceProjectId: string;
}): Promise<ProjectTemplate | null> {
  try {
    const resp = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (resp.ok) {
      const json = await safeJson<{ template: ProjectTemplate }>(resp);
      if (json) return json.template;
    }
  } catch { /* fall through */ }
  return null;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function patchProject(
  id: string,
  patch: Partial<Project>,
): Promise<Project | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (resp.ok) {
      const json = await safeJson<{ project: Project }>(resp);
      if (json) return json.project;
    }
  } catch { /* fall through */ }

  // localStorage fallback
  const projects = lsGetProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const updated = { ...projects[idx]!, ...patch, updatedAt: Date.now() };
  projects[idx] = updated;
  lsSetProjects(projects);
  return updated;
}

export async function deleteProject(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (resp.ok) return true;
  } catch { /* fall through */ }

  // localStorage fallback
  const projects = lsGetProjects();
  lsSetProjects(projects.filter((p) => p.id !== id));
  const convos = lsGetConversations().filter((c) => c.projectId !== id);
  lsSetConversations(convos);
  return true;
}

// ---------- conversations ----------

export async function listConversations(
  projectId: string,
): Promise<Conversation[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`,
    );
    if (resp.ok) {
      const json = await safeJson<{ conversations: Conversation[] }>(resp);
      if (json) return json.conversations ?? [];
    }
  } catch { /* fall through */ }
  return lsGetConversations().filter((c) => c.projectId === projectId);
}

export async function createConversation(
  projectId: string,
  title?: string,
): Promise<Conversation | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    );
    if (resp.ok) {
      const json = await safeJson<{ conversation: Conversation }>(resp);
      if (json) return json.conversation;
    }
  } catch { /* fall through */ }

  // localStorage fallback
  const now = Date.now();
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    projectId,
    title: title ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const convos = lsGetConversations();
  lsSetConversations([conversation, ...convos]);
  return conversation;
}

export async function patchConversation(
  projectId: string,
  conversationId: string,
  patch: Partial<Conversation>,
): Promise<Conversation | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    if (resp.ok) {
      const json = await safeJson<{ conversation: Conversation }>(resp);
      if (json) return json.conversation;
    }
  } catch { /* fall through */ }

  // localStorage fallback
  const convos = lsGetConversations();
  const idx = convos.findIndex((c) => c.id === conversationId);
  if (idx === -1) return null;
  const updated = { ...convos[idx]!, ...patch, updatedAt: Date.now() };
  convos[idx] = updated;
  lsSetConversations(convos);
  return updated;
}

export async function deleteConversation(
  projectId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE' },
    );
    if (resp.ok) return true;
  } catch { /* fall through */ }

  lsSetConversations(lsGetConversations().filter((c) => c.id !== conversationId));
  return true;
}

// ---------- messages ----------

export async function listMessages(
  projectId: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    if (resp.ok) {
      const json = await safeJson<{ messages: ChatMessage[] }>(resp);
      if (json) return json.messages ?? [];
    }
  } catch { /* fall through */ }
  const all = lsGetMessages();
  return all[conversationId] ?? [];
}

export async function saveMessage(
  projectId: string,
  conversationId: string,
  message: ChatMessage,
): Promise<void> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      },
    );
    if (resp.ok) return;
  } catch { /* fall through */ }

  // localStorage fallback
  const all = lsGetMessages();
  const msgs = all[conversationId] ?? [];
  const idx = msgs.findIndex((m) => m.id === message.id);
  if (idx >= 0) msgs[idx] = message; else msgs.push(message);
  all[conversationId] = msgs;
  lsSetMessages(all);
}

// ---------- tabs ----------

export async function loadTabs(projectId: string): Promise<OpenTabsState> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/tabs`,
    );
    if (resp.ok) {
      const json = await safeJson<OpenTabsState>(resp);
      if (json) return json;
    }
  } catch { /* fall through */ }
  const stored = lsGet<Record<string, OpenTabsState>>(LS_TABS_KEY, {});
  return stored[projectId] ?? { tabs: [], active: null };
}

export async function saveTabs(
  projectId: string,
  state: OpenTabsState,
): Promise<void> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tabs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (resp.ok) return;
  } catch { /* fall through */ }

  // localStorage fallback
  const all = lsGet<Record<string, OpenTabsState>>(LS_TABS_KEY, {});
  all[projectId] = state;
  lsSet(LS_TABS_KEY, all);
}

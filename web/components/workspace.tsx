"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { UserButton } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  FileText,
  History,
  Layers,
  Loader2,
  Menu,
  MessageSquareText,
  Plus,
  Search,
  Waypoints,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HandoffRecommendation } from "./handoff-recommendation";
import { ConnectionSetup } from "./connection-setup";
import type { Recommendation } from "@/lib/work-recommendation";
import type { Activity } from "@/lib/activity-model";
import {
  labels,
  type Memory,
  type Page,
  type Project,
  type ProjectCurrent,
  type RecordCard,
  type Rule,
  type SourceMeta,
  type TopicCard,
  type TopicCurrent,
} from "@/lib/model";

const date = (v: string | null, year = false, timeZone = 'Asia/Seoul') =>
  v
    ? new Date(v).toLocaleDateString("ko-KR", {
        timeZone,
        ...(year ? { year: "numeric" as const } : {}),
        month: "long",
        day: "numeric",
      })
    : "관찰 시점 미상";
const nav = [
  ["now", "지금", BookOpen],
  ["topics", "주제", Layers],
  ["work", "이어갈 일", Waypoints],
  ["history", "지나온 변화", History],
  ["activities", "작업 결과", FileText],
] as const;
type Query = Record<string, string | number | undefined>;
async function request<T>(
  projectId: string,
  query: Query,
  init?: RequestInit,
): Promise<T> {
  const params = new URLSearchParams({ project: projectId });
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined) params.set(k, String(v));
  });
  const response = await fetch(`/api/workspace?${params}`, {
    cache: "no-store",
    ...init,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "기록을 가져오지 못했어요.");
  return data;
}
function useResource<T>(projectId: string, query: Query | null, refresh = 0) {
  const key = query ? JSON.stringify(query) : "";
  const [state, set] = useState<{
    data: T | null;
    error: string;
    loading: boolean;
  }>({ data: null, error: "", loading: !!query });
  useEffect(() => {
    if (!key) {
      set({ data: null, error: "", loading: false });
      return;
    }
    const abort = new AbortController();
    set({ data: null, error: "", loading: true });
    request<T>(projectId, JSON.parse(key), { signal: abort.signal })
      .then((data) => set({ data, error: "", loading: false }))
      .catch((e) => {
        if (!abort.signal.aborted)
          set({ data: null, error: e.message, loading: false });
      });
    return () => abort.abort();
  }, [projectId, key, refresh]);
  return state;
}
function Prose({ children }: { children: string }) {
  return (
    <div className="prose">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}
function Badge({ state, children }: { state: string; children?: ReactNode }) {
  return (
    <span className={`badge ${state}`}>
      <span className="badge-dot" />
      {children ?? labels[state] ?? state}
    </span>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
function Loading() {
  return (
    <div className="loading" role="status">
      <Loader2 size={18} className="spin" /> 현재 기록을 읽고 있어요
    </div>
  );
}
function Failure({ children }: { children: string }) {
  return (
    <p className="error" role="alert">
      {children}
    </p>
  );
}

export default function Workspace({ projectId }: { projectId: string }) {
  const router = useRouter(),
    params = useSearchParams();
  const requestedView = params.get("view") ?? "now";
  const view = requestedView === "notes" ? "work" : requestedView,
    topicSlug = params.get("topic"),
    recordId = params.get("record"),
    activityId = params.get("activity");
  const [refresh, setRefresh] = useState(0),
    [sidebar, setSidebar] = useState(false),
    [connectOpen, setConnectOpen] = useState(false),
    [projectOpen, setProjectOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const current = useResource<ProjectCurrent>(
    projectId,
    { view: "project" },
    refresh,
  );
  const projects = useResource<Page<Project>>(
    projectId,
    { view: "projects", limit: 30 },
    refresh,
  );
  const revision = useRef<number | null>(null);
  useEffect(() => {
    if (current.data) revision.current = current.data.project.revision;
  }, [current.data]);
  useEffect(() => {
    let cancelled = false,
      pending = false;
    const check = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const r = await request<{ revision: number }>(projectId, {
          view: "cursor",
        });
        if (
          !cancelled &&
          revision.current !== null &&
          r.revision !== revision.current
        ) {
          revision.current = r.revision;
          setRefresh((x) => x + 1);
        }
      } catch {
        /* Each visible read surfaces errors; failed pings never discard drafts. */
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(check, 30000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [projectId]);
  const href = useCallback(
    (next: Query = {}) => {
      const p = new URLSearchParams({ project: projectId });
      Object.entries(next).forEach(([k, v]) => {
        if (v !== undefined) p.set(k, String(v));
      });
      return `/?${p}`;
    },
    [projectId],
  );
  const openRecord = (id: string) =>
    router.push(
      href({ view, ...(topicSlug ? { topic: topicSlug } : {}), record: id }),
    );
  const topics = current.data?.topics.items ?? [];
  const activeTopic = topics.find(
    (t) => t.slug === topicSlug || t.id === topicSlug,
  );
  const onSaved = () => {
    setRefresh((x) => x + 1);
  };
  useEffect(() => setSidebar(false), [view, topicSlug]);
  const section = topicSlug
    ? (activeTopic?.title ?? "주제")
    : view === "contexts"
      ? "알아둘 것"
      : (nav.find((n) => n[0] === view)?.[1] ?? "검색");
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        본문으로 이동
      </a>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="메뉴 닫기"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? "is-open" : ""}`}>
        <Link href="/" className="brand" aria-label="Developlog 프로젝트 목록">
          <span className="brand-mark">
            <BookOpen size={21} />
          </span>
          <span>
            developlog<small>프로젝트를 이어 읽는 곳</small>
          </span>
        </Link>
        <div className="project-picker">
          <div className="project-picker-heading">
            <label htmlFor="project-select">나의 프로젝트</label>
            <Link href="/">전체 보기</Link>
          </div>
          <div className="project-select-row">
            <select
              id="project-select"
              value={projectId}
              onChange={(e) => {
                window.location.href = `/?project=${encodeURIComponent(e.target.value)}`;
              }}
            >
              {projects.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              )) ?? (
                <option value={projectId}>
                  {current.data?.project.name ?? "불러오는 중"}
                </option>
              )}
            </select>
            <button
              className="icon-button"
              aria-label="새 프로젝트"
              onClick={() => setProjectOpen(true)}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
        <nav aria-label="주 메뉴">
          {nav.map(([key, label, Icon]) => (
            <Link
              key={key}
              href={href({ view: key })}
              className={`nav-item ${!topicSlug && view === key ? "selected" : ""}`}
              aria-current={!topicSlug && view === key ? "page" : undefined}
            >
              <Icon size={18} />
              {label}
            </Link>
          ))}
          <Link className="nav-item" href={href({ view: "search" })}>
            <Search size={18} />
            검색
          </Link>
        </nav>
        {!!topics.length && (
          <div className="sidebar-topics">
            <p>프로젝트의 주제</p>
            {topics.map((t) => (
              <Link
                key={t.id}
                href={href({ view: "topics", topic: t.slug })}
                className={activeTopic?.id === t.id ? "selected" : ""}
              >
                <span
                  className={`topic-dot ${t.signals.some((s) => s.state === "temporary") ? "amber" : ""}`}
                />
                {t.title}
              </Link>
            ))}
            {current.data?.topics.next_cursor && (
              <Link href={href({ view: "topics" })}>
                모든 주제 보기 <ArrowRight size={13} />
              </Link>
            )}
          </div>
        )}
        <div className="sidebar-bottom">
          <button onClick={() => setConnectOpen(true)}>
            <MessageSquareText size={17} /> 연결 설정{" "}
            <ArrowRight size={14} />
          </button>
          <div className="user-row">
            <UserButton />
            <span>나와 AI의 프로젝트 기억</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="메뉴 열기"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <span>{current.data?.project.name ?? "Developlog"}</span>
            <ChevronRight size={13} />
            <strong>{section}</strong>
          </div>
          <div className="top-actions">
            <form
              className="search-box"
              onSubmit={(e) => {
                e.preventDefault();
                if (searchText.trim())
                  router.push(href({ view: "search", q: searchText.trim() }));
              }}
            >
              <Search size={16} />
              <input
                aria-label="프로젝트 안에서 검색"
                placeholder="이 프로젝트에서 찾기"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
            </form>
          </div>
        </header>
        <main id="main-content" className="main-content">
          {current.error ? (
            <>
              <Failure>{current.error}</Failure>
              <button className="button" onClick={onSaved}>
                다시 읽기
              </button>
            </>
          ) : !current.data ? (
            <Loading />
          ) : topicSlug ? (
            <TopicView
              key={topicSlug}
              projectId={projectId}
              id={topicSlug}
              refresh={refresh}
              openRecord={openRecord}
              href={href}
            />
          ) : view === "now" ? (
            <Home data={current.data} href={href} openRecord={openRecord} />
          ) : view === "topics" ? (
            <TopicsView projectId={projectId} refresh={refresh} href={href} />
          ) : view === "activities" ? (
            <ActivitiesView projectId={projectId} refresh={refresh} href={href} />
          ) : ["work", "history", "contexts"].includes(view) ? (
            <RecordsView
              key={view}
              projectId={projectId}
              refresh={refresh}
              kind={
                view === "work"
                  ? "work"
                  : view === "history"
                    ? "event"
                    : view === "contexts"
                      ? "context"
                      : "context"
              }
              openRecord={openRecord}
            />
          ) : view === "search" ? (
            <SearchView
              projectId={projectId}
              query={params.get("q") ?? ""}
              refresh={refresh}
              href={href}
              openRecord={openRecord}
            />
          ) : (
            <Empty>화면을 찾을 수 없어요. 왼쪽 메뉴에서 이어가 주세요.</Empty>
          )}
          <footer className="page-footer">
            <span>developlog</span>
            <span>현재를 읽고, 이유를 남기고, 다음으로.</span>
          </footer>
        </main>
      </div>
      {recordId && (
        <RecordDialog
          projectId={projectId}
          id={recordId}
          refresh={refresh}
          close={() =>
            router.push(
              href({
                view,
                ...(topicSlug ? { topic: topicSlug } : {}),
                ...(params.get("q") ? { q: params.get("q")! } : {}),
              }),
            )
          }
        />
      )}
      {activityId && (
        <ActivityDialog projectId={projectId} id={activityId} refresh={refresh}
          close={() => router.push(href({ view, ...(recordId ? { record: recordId } : {}), ...(topicSlug ? { topic: topicSlug } : {}) }))} />
      )}
      {connectOpen && (
        <Dialog
          title="프로젝트 연결 설정"
          close={() => setConnectOpen(false)}
        >
          {current.data ? <ConnectionSetup key={current.data.project.id + current.data.project.mode + current.data.project.github_repository} project={current.data.project} /> : current.error ? <Failure>{current.error}</Failure> : <Loading />}
        </Dialog>
      )}
      {projectOpen && (
        <ProjectDialog
          projectId={projectId}
          close={() => setProjectOpen(false)}
        />
      )}
    </div>
  );
}

function Home({
  data,
  href,
  openRecord,
}: {
  data: ProjectCurrent;
  href: (q?: Query) => string;
  openRecord: (id: string) => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROJECT / NOW</p>
          <h1>
            {data.project.name}
          </h1>
          <p className="lead">
            {data.project.description ||
              "아직 프로젝트의 소개가 없어요. ChatGPT에서 목적과 첫 주제를 정리해 보세요."}
          </p>
        </div>
        <span className="as-of">
          <span className="live-dot" />
          {date(data.project.updated_at)} 기록 기준
        </span>
      </div>
      <div className="home-grid">
        <div className="home-main">
          {!!data.pending_activities.items.length && (
            <div className="condition">
              <strong>아직 현재 기억에 반영하지 못한 작업 결과가 있어요</strong>
              {data.pending_activities.items.map(a => <p key={a.id}><Link href={href({ view: "activities", activity: a.id })}>{a.summary}</Link></p>)}
              <Link className="text-link" href={href({ view: "activities" })}>작업 결과와 반영 상태 모두 읽기</Link>
              <small>다음 작업 전에 ChatGPT에서 반영 대기 결과를 확인해 주세요.</small>
            </div>
          )}
          <section>
            <SectionHeading
              title="지금 알아둘 것"
              subtitle="다음 작업의 판단을 바꾸는 사정"
            />
            <div className="context-list">
              {data.context.items.map((r) => (
                <ContextCard key={r.id} record={r} open={openRecord} />
              ))}
              {!data.context.items.length && (
                <Empty>별도로 유지 중인 사정은 없어요.</Empty>
              )}
            </div>
            {data.context.next_cursor && (
              <Link className="text-link" href={href({ view: "contexts" })}>
                알아둘 사정 모두 읽기 <ArrowRight size={14} />
              </Link>
            )}
          </section>
          <section>
            <SectionHeading
              title="주제로 읽는 현재"
              subtitle="설계, 실제 동작, 그리고 그 사이의 이유"
              action={
                <Link href={href({ view: "topics" })}>
                  모든 주제 <ArrowRight size={14} />
                </Link>
              }
            />
            <div className="topic-grid">
              {data.topics.items.map((t) => (
                <TopicTile
                  key={t.id}
                  topic={t}
                  href={href({ view: "topics", topic: t.slug })}
                />
              ))}
            </div>
            {!data.topics.items.length && (
              <Empty>
                첫 주제가 아직 없어요. ChatGPT에 이 프로젝트가 무엇을 만드는지
                알려주면 함께 정리할 수 있어요. 다음 작업도 ChatGPT에서
                정리해 이어갈 일에 남겨 주세요.
              </Empty>
            )}
          </section>
          <section>
            <SectionHeading
              title="최근, 달라진 것"
              subtitle="수정 횟수보다 남겨둘 만한 변화와 이유"
              action={
                <Link href={href({ view: "history" })}>
                  흐름 보기 <ArrowRight size={14} />
                </Link>
              }
            />
            <Timeline records={data.recent.items} open={openRecord} />
          </section>
        </div>
        <aside className="work-aside">
          {!!data.candidate_work.items.length && <WorkGroup title="승인을 기다리는 후속 작업" state="candidate" records={data.candidate_work.items} empty="" open={openRecord} />}
          <div className="aside-label">
            <Waypoints size={16} /> 이어갈 일
          </div>
          <WorkGroup
            title="지금 하는 일"
            state="active"
            records={data.active_work.items}
            empty="진행 중으로 기록된 일은 없어요."
            open={openRecord}
          />
          <WorkGroup
            title="다음에 선택할 일"
            state="ready"
            records={data.ready_work.items}
            empty="새로 선택한 작업은 아직 없어요."
            open={openRecord}
          />
          <WorkGroup
            title="확인을 기다리는 일"
            state="blocked"
            records={data.blocked_work.items}
            empty="기다리는 일은 없어요."
            open={openRecord}
          />
          <Link className="text-link" href={href({ view: "work" })}>
            모든 작업과 선행 조건 <ArrowRight size={15} />
          </Link>
          <div className="margin-note">
            <Waypoints size={20} />
            <p>다음에 할 일은<br />한곳에서 이어가요.</p>
            <span>ChatGPT에서 작업을 정리하고,<br />이어갈 일에서 확인해요.</span>
          </div>
        </aside>
      </div>
    </>
  );
}
function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
function TopicTile({ topic, href }: { topic: TopicCard; href: string }) {
  const signal =
    topic.signals.find((s) => s.reported) ??
    topic.signals.find((s) => s.state === "temporary") ??
    topic.signals.find((s) => s.state === "planned") ??
    topic.signals[0];
  return (
    <Link className="topic-tile" href={href}>
      <div className="topic-tile-top">
        <span className="topic-icon">
          <Layers size={17} />
        </span>
        <ArrowRight size={16} />
      </div>
      <h3>{topic.title}</h3>
      <p>{topic.current ?? topic.intro}</p>
      <div className="topic-tile-status">
        {signal ? (
          <>
            <Badge state={signal.reported ? "unknown" : signal.state}>
              {signal.reported ? "변경 보고 · 확인 전" : labels[signal.state]}
            </Badge>
            <span>{signal.title}</span>
          </>
        ) : (
          <span className="quiet-state">설계와 현재 기록 읽기</span>
        )}
      </div>
    </Link>
  );
}
function ContextCard({
  record,
  open,
}: {
  record: RecordCard;
  open: (id: string) => void;
}) {
  return (
    <button className="context-card" onClick={() => open(record.id)}>
      <span className="context-line" />
      <div>
        <strong>{record.title}</strong>
        <p>{record.summary}</p>
        {record.resolution && <small>해제·재검토 조건 · {record.resolution}</small>}
      </div>
      <ChevronRight size={16} />
    </button>
  );
}
function WorkGroup({
  title,
  state,
  records,
  empty,
  open,
}: {
  title: string;
  state: string;
  records: RecordCard[];
  empty: string;
  open: (id: string) => void;
}) {
  return (
    <div className="work-group">
      <h3>
        <span className={`work-dot ${state}`} />
        {title}
      </h3>
      {records.length ? (
        records.map((r) => (
          <button className="work-row" key={r.id} onClick={() => open(r.id)}>
            <span>{r.title}</span>
            <ChevronRight size={14} />
            <small>{r.summary}</small>
            {!!r.waiting_for?.length && <small>선행 · {r.waiting_for.map((w) => w.title).join(" · ")}</small>}
          </button>
        ))
      ) : (
        <p className="quiet">{empty}</p>
      )}
    </div>
  );
}
function Timeline({
  records,
  open,
}: {
  records: RecordCard[];
  open: (id: string) => void;
}) {
  return records.length ? (
    <div className="timeline">
      {records.map((r) => (
        <button
          key={r.id}
          className="timeline-event"
          onClick={() => open(r.id)}
        >
          <span className="timeline-node" />
          <time>{date(r.occurred_at, true, r.project_timezone)}</time>
          <h3>{r.title}</h3>
          <p>{r.summary}</p>
          <span className="event-reason">{r.reason}</span>
        </button>
      ))}
    </div>
  ) : (
    <Empty>
      아직 남겨둔 변화가 없어요. 의미 있는 결정이나 관찰이 생기면 여기에
      이어져요.
    </Empty>
  );
}

function TopicsView({
  projectId,
  refresh,
  href,
}: {
  projectId: string;
  refresh: number;
  href: (q?: Query) => string;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const data = useResource<Page<TopicCard>>(
    projectId,
    { view: "topics", cursor, limit: 18 },
    refresh,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROJECT / TOPICS</p>
          <h1>주제로 이어 읽기</h1>
          <p className="lead">
            무엇을 만들고 있는지부터, 왜 이렇게 되었는지까지.
          </p>
        </div>
      </div>
      {data.error ? (
        <Failure>{data.error}</Failure>
      ) : data.data ? (
        <>
          <div className="topic-grid wide">
            {data.data.items.map((t) => (
              <TopicTile
                key={t.id}
                topic={t}
                href={href({ view: "topics", topic: t.slug })}
              />
            ))}
          </div>
          {!data.data.items.length && (
            <Empty>첫 주제를 ChatGPT에서 함께 정리해 보세요.</Empty>
          )}
          <Pagination
            next={data.data.next_cursor}
            cursor={cursor}
            set={setCursor}
          />
        </>
      ) : (
        <Loading />
      )}
    </>
  );
}
function TopicView({
  projectId,
  id,
  refresh,
  openRecord,
  href,
}: {
  projectId: string;
  id: string;
  refresh: number;
  openRecord: (id: string) => void;
  href: (q?: Query) => string;
}) {
  const resource = useResource<TopicCurrent>(
    projectId,
    { view: "topic", id },
    refresh,
  );
  if (resource.error) return <Failure>{resource.error}</Failure>;
  if (!resource.data) return <Loading />;
  const { topic, context, work } = resource.data;
  return (
    <div className="topic-page">
      <Link className="back-link" href={href({ view: "topics" })}>
        <ArrowLeft size={14} /> 주제 전체
      </Link>
      <div className="page-heading topic-heading">
        <div>
          <p className="eyebrow">TOPIC / CURRENT</p>
          <h1>{topic.title}</h1>
          <p className="lead">{topic.intro}</p>
        </div>
        <span className="as-of">마지막 기록 {date(topic.updated_at)}</span>
      </div>
      <section className="comparison-section">
        <SectionHeading
          title="설계와 지금의 실제"
          subtitle="채택한 의도와 근거가 있는 동작을 나란히 읽어요."
        />
        <div className="comparison-head">
          <span>기준</span>
          <span>채택한 설계</span>
          <span>마지막으로 확인한 실제</span>
        </div>
        {topic.rules.length ? (
          topic.rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              projectId={projectId}
              sources={resource.data!.sources}
            />
          ))
        ) : (
          <Empty>
            아직 정리한 설계·동작 항목이 없어요. 모르는 상태를 구현 완료로
            채우지 않아요.
          </Empty>
        )}
      </section>
      {!!context.items.length && (
        <section className="topic-context">
          <div className="section-kicker">작업 전에 알아둘 것</div>
          {context.items.map((r) => (
            <ContextCard key={r.id} record={r} open={openRecord} />
          ))}
          {context.next_cursor && (
            <RelatedMore
              projectId={projectId}
              topicId={topic.id}
              kind="context"
              cursor={context.next_cursor}
              openRecord={openRecord}
            />
          )}
        </section>
      )}
      <div className="topic-bottom-grid">
        <section>
          <SectionHeading
            title="이어갈 일"
            subtitle="지금 하는 일과 아직 기다리는 일을 구분해요."
          />
          {work.items.length ? (
            work.items.map((r) => (
              <RecordTile key={r.id} record={r} open={openRecord} />
            ))
          ) : (
            <Empty>이 주제에서 진행하거나 이어갈 일은 아직 없어요.</Empty>
          )}
          {work.next_cursor && (
            <RelatedMore
              projectId={projectId}
              topicId={topic.id}
              kind="work"
              cursor={work.next_cursor}
              openRecord={openRecord}
            />
          )}
        </section>
      </div>
      <LazySection
        title="왜 이렇게 되었나"
        subtitle="이 주제의 의미 있는 변화와 이유"
        projectId={projectId}
        query={{
          view: "records",
          kind: "event",
          topic: topic.id,
          states: "published",
        }}
        render={(d: Page<RecordCard>) => (
          <>
            <Timeline records={d.items} open={openRecord} />
            {d.next_cursor && (
              <RelatedMore
                projectId={projectId}
                topicId={topic.id}
                kind="event"
                cursor={d.next_cursor}
                openRecord={openRecord}
              />
            )}
          </>
        )}
      />
      <LazySection
        title="상세 규칙과 근거"
        subtitle="판정의 경계, 관찰 범위, 필요한 원문"
        projectId={projectId}
        query={{ view: "topic_detail", id: topic.id }}
        render={(d: { detail: string; sources: SourceMeta[] }) => (
          <>
            <Prose>{d.detail || "별도로 정리한 상세 규칙은 없어요."}</Prose>
            <Sources projectId={projectId} sources={d.sources} />
            <Audit projectId={projectId} type="topic" id={topic.id} />
          </>
        )}
      />
    </div>
  );
}
function RuleRow({
  rule: r,
  projectId,
  sources,
}: {
  rule: Rule;
  projectId: string;
  sources: SourceMeta[];
}) {
  const stale =
    r.gap.design_version !== (r.design?.version ?? 0) ||
    r.gap.actual_version !== (r.actual?.version ?? 0);
  return (
    <article className="rule-row">
      <div className="rule-name">
        <h3>{r.title}</h3>
        <Badge state={stale ? "unknown" : r.gap.state} />
      </div>
      <div className="rule-design">
        <span className="mobile-label">채택한 설계</span>
        <p>{r.design?.text ?? "채택한 설계가 아직 정리되지 않았어요."}</p>
        {r.design?.reason && (
          <details className="small-detail">
            <summary>이 기준의 이유</summary>
            <p>{r.design.reason}</p>
            <Sources
              projectId={projectId}
              sources={sources.filter((s) =>
                r.design?.source_ids.includes(s.id),
              )}
            />
          </details>
        )}
      </div>
      <div className="rule-actual">
        <span className="mobile-label">마지막으로 확인한 실제</span>
        <p>
          {r.actual?.text ??
            "아직 확인 근거가 없어요. 구현되지 않았다는 뜻은 아니에요."}
        </p>
        {r.actual?.evidence.map((e, i) => (
          <details key={`${e.source_id}-${i}`} className="evidence-detail">
            <summary>
              <FileText size={12} />
              {labels[e.method]} <ChevronDown size={12} />
            </summary>
            <div className="evidence-body">
              <p>{e.scope}</p>
              <small>대상 · {e.target}</small>
              <small>{date(e.observed_at, true)}</small>
              <SourceLink
                projectId={projectId}
                source={
                  sources.find((s) => s.id === e.source_id) ?? {
                    id: e.source_id,
                    title: "연결된 근거",
                    origin: "",
                    url: null,
                    ref: null,
                    observed_at: "",
                    captured_by: null,
                  }
                }
              />
            </div>
          </details>
        ))}
      </div>
      {(r.gap.reason || stale) && (
        <div className={`rule-reason ${r.gap.state}`}>
          <span>차이와 사정</span>
          <p>
            {stale
              ? "설계 또는 실제 기록이 바뀌어 설명을 다시 대조해야 해요."
              : r.gap.reason}
          </p>
        </div>
      )}
      {r.reported && (
        <div className="pending-report">
          <Clock3 size={16} />
          <div>
            <strong>변경 보고가 왔어요 · 아직 확인 전</strong>
            <p>{r.reported.text}</p>
            <small>대상 · {r.reported.target}</small>
            <p className="quiet">
              위의 마지막 확인 상태는 검증 근거가 연결될 때 갱신돼요.
            </p>
            <details>
              <summary>변경 보고의 근거</summary>
              <Sources
                projectId={projectId}
                sources={sources.filter((s) =>
                  r.reported?.source_ids.includes(s.id),
                )}
              />
            </details>
          </div>
        </div>
      )}
    </article>
  );
}
function Pagination({
  next,
  cursor,
  set,
}: {
  next: string | null;
  cursor?: string;
  set: (s: string | undefined) => void;
}) {
  return (
    <div className="pagination">
      {cursor && (
        <button className="button" onClick={() => set(undefined)}>
          처음으로
        </button>
      )}
      {next && (
        <button className="button" onClick={() => set(next)}>
          다음 기록 <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
function RecordTile({
  record: r,
  open,
}: {
  record: RecordCard;
  open: (id: string) => void;
}) {
  return (
    <button className="record-tile" onClick={() => open(r.id)}>
      <div>
        <Badge state={r.state} />
        <ChevronRight size={15} />
      </div>
      <h3>{r.title}</h3>
      <p>{r.summary}</p>
      {!!r.waiting_for?.length && <small>먼저 할 일 · {r.waiting_for.map((w) => w.title).join(" · ")}</small>}
      {r.resolution && <small>{r.resolution}</small>}
    </button>
  );
}
function RelatedMore({
  projectId,
  topicId,
  kind,
  cursor: initialCursor,
  openRecord,
}: {
  projectId: string;
  topicId: string;
  kind: string;
  cursor: string;
  openRecord: (id: string) => void;
}) {
  const [cursor, set] = useState<string | undefined>();
  const states =
    kind === "context"
      ? "active"
      : kind === "work"
        ? "active,ready,blocked"
        : "published";
  const d = useResource<Page<RecordCard>>(
    projectId,
    cursor
      ? { view: "records", topic: topicId, kind, states, cursor, limit: 6 }
      : null,
  );
  return (
    <>
      {!cursor && (
        <button className="text-link" onClick={() => set(initialCursor)}>
          관련 내용 더 읽기 <ArrowDown size={14} />
        </button>
      )}
      {d.loading && <Loading />}
      {d.error && <Failure>{d.error}</Failure>}
      {d.data?.items.map((r) => (
        <RecordTile key={r.id} record={r} open={openRecord} />
      ))}
      {d.data?.next_cursor && (
        <button className="text-link" onClick={() => set(d.data!.next_cursor!)}>
          다음 내용 <ArrowRight size={14} />
        </button>
      )}
    </>
  );
}
const memoryStatusLabels = { pending: "기억 반영 대기", applied: "기억 반영 완료", superseded: "후속 결과로 정정" };
function ActivitiesView({ projectId, refresh, href }: {
  projectId: string; refresh: number; href: (q?: Query) => string;
}) {
  const [status, setStatus] = useState("pending");
  const [cursor, setCursor] = useState<string | undefined>();
  const resource = useResource<Page<Pick<Activity, "id" | "summary" | "memory_status" | "occurred_at">>>(
    projectId, { view: "activities", status: status || undefined, cursor, limit: 16 }, refresh,
  );
  return <>
    <div className="page-heading"><div><p className="eyebrow">PROJECT / ACTIVITY</p><h1>실행 결과와 기억 반영</h1>
      <p className="lead">작업 결과는 보존하고, 현재 기억에 반영됐는지 따로 확인해요.</p></div></div>
    <div className="tabs" role="group" aria-label="기억 반영 상태">
      {[["pending", "반영 대기"], ["", "전체 결과"]].map(([value, label]) => <button key={value}
        aria-pressed={status === value} className={status === value ? "active" : ""}
        onClick={() => { setStatus(value); setCursor(undefined); }}>{label}</button>)}
    </div>
    {resource.error ? <Failure>{resource.error}</Failure> : !resource.data ? <Loading /> : <>
      <div className="record-grid">{resource.data.items.map(a => <Link className="record-tile" key={a.id}
        href={href({ view: "activities", activity: a.id })}>
        <Badge state={a.memory_status}>{memoryStatusLabels[a.memory_status]}</Badge>
        <h3>{a.summary}</h3><small>{date(a.occurred_at, true)}</small>
      </Link>)}</div>
      {!resource.data.items.length && <Empty>이 상태의 작업 결과는 아직 없어요.</Empty>}
      <Pagination next={resource.data.next_cursor} cursor={cursor} set={setCursor} />
    </>}
  </>;
}
function ActivityDialog({ projectId, id, refresh, close }: {
  projectId: string; id: string; refresh: number; close: () => void;
}) {
  const resource = useResource<{ activity: Activity; notice: string; corrections: {id: string; summary: string}[] }>(
    projectId, { view: "activity", id }, refresh,
  );
  const a = resource.data?.activity;
  return <Dialog title={a?.summary ?? "작업 결과 읽기"} close={close} wide>
    {resource.error ? <Failure>{resource.error}</Failure> : !a ? <Loading /> : <>
      <Badge state={a.memory_status}>{memoryStatusLabels[a.memory_status]}</Badge>
      <p className="quiet">{resource.data?.notice}</p>
      <Prose>{a.result}</Prose>
      <p className="quiet">{date(a.occurred_at, true)} · {a.payload.channel === "handoff" ? "전달받은 작업 결과" : "연결된 작업 결과"}</p>
      <section><h3>확인한 결과</h3>{a.payload.verification.length ? a.payload.verification.map(e =>
        <p key={e.id}><strong>{labels[e.method] ?? e.method}</strong> · {e.outcome}<br />{e.scope}<br /><small>{e.target}</small></p>
      ) : <Empty>검증 근거가 첨부되지 않은 보고예요.</Empty>}</section>
      {a.memory_status === "pending" && <div className="condition"><strong>실행 결과는 저장됐고, 기억 반영은 기다리고 있어요.</strong>
        <p>ChatGPT에서 이 작업 결과와 최신 주제를 읽고 충돌을 정리해 주세요.</p>
        <details><summary>반영 대기 이유</summary><pre>{JSON.stringify(a.conflicts, null, 2)}</pre></details>
      </div>}
      {a.work_id && <p><Link className="text-link" href={`/?${new URLSearchParams({ project: projectId, view: "work", record: a.work_id })}`}>연결된 작업 읽기</Link></p>}
      {resource.data?.corrections.map(c => <p key={c.id}><Link href={`/?${new URLSearchParams({ project: projectId, view: "activities", activity: c.id })}`}>정정 결과 · {c.summary}</Link></p>)}
      <details><summary>ChatGPT에 전달할 결과 ID</summary><code>{a.id}</code></details>
    </>}
  </Dialog>;
}
function RecordsView({
  projectId,
  refresh,
  kind: initialKind,
  openRecord,
}: {
  projectId: string;
  refresh: number;
  kind: string;
  openRecord: (id: string) => void;
}) {
  const [filter, setFilter] = useState(
    initialKind === "work"
      ? "candidate,active,ready,blocked"
      : initialKind === "context"
        ? "active"
        : "published,corrected",
  );
  const [kind, setKind] = useState(initialKind),
    [cursor, setCursor] = useState<string | undefined>(),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  useEffect(() => {
    setKind(initialKind);
    setFilter(
      initialKind === "work"
        ? "candidate,active,ready,blocked"
        : initialKind === "context"
          ? "active"
          : "published,corrected",
    );
    setCursor(undefined);
  }, [initialKind]);
  const query: Query = {
    view: "records",
    kind,
    states: filter,
    cursor,
    limit: 16,
  };
  if (kind === 'event' && from) query.from_date = from;
  if (kind === 'event' && to) query.to_date = to;
  const resource = useResource<Page<RecordCard>>(projectId, query, refresh);
  const options =
    initialKind === "work"
      ? [
          ["candidate,active,ready,blocked", "이어갈 일"],
          ["candidate", "승인 전 후보"],
          ["active", "진행 중"],
          ["ready", "다음 후보"],
          ["blocked", "기다리는 중"],
          ["done,cancelled", "마친 일"],
        ]
      : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            PROJECT /{" "}
            {initialKind === "work"
              ? "WORK"
              : initialKind === "event"
                ? "HISTORY"
                : initialKind === "context"
                  ? "CONTEXT"
                  : "CONTEXT"}
          </p>
          <h1>
            {initialKind === "work"
              ? "다음으로 이어갈 일"
              : initialKind === "event"
                ? "지금에 이르기까지"
                : initialKind === "context"
                  ? "작업 전에 알아둘 것"
                  : "작업 전에 알아둘 것"}
          </h1>
          <p className="lead">
            {initialKind === "work"
              ? "다음에 할 일과, 먼저 확인할 조건을 한곳에서 읽어요."
              : initialKind === "event"
                ? "무엇이 달라졌고, 왜 그 방향을 택했는지."
                : initialKind === "context"
                  ? "현재 판단을 바꾸는 사정과 다시 판단할 조건이에요."
                  : "현재 판단을 바꾸는 사정과 다시 판단할 조건이에요."}
          </p>
        </div>
      </div>
      {!!options.length && (
        <div className="tabs" role="group" aria-label="목록 필터">
          {options.map(([value, label]) => (
            <button
              key={value}
              aria-pressed={filter === value}
              className={filter === value ? "active" : ""}
              onClick={() => {
                setCursor(undefined);
                setFilter(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {kind === "event" && (
        <div className="date-filter">
          <label>
            시작일{" "}
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          <span>—</span>
          <label>
            마지막 날{" "}
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          <small>한국 시간 기준</small>
        </div>
      )}
      {resource.error ? (
        <Failure>{resource.error}</Failure>
      ) : resource.data ? (
        <>
          {kind === "event" ? (
            <Timeline records={resource.data.items} open={openRecord} />
          ) : (
            <div className="record-grid">
              {resource.data.items.map((r) => (
                <RecordTile key={r.id} record={r} open={openRecord} />
              ))}
            </div>
          )}
          {!resource.data.items.length && kind !== "event" && (
            <Empty>
              이 상태의 기록은 아직 없어요.
            </Empty>
          )}
          <Pagination
            next={resource.data.next_cursor}
            cursor={cursor}
            set={setCursor}
          />
        </>
      ) : (
        <Loading />
      )}
    </>
  );
}
function SearchView({
  projectId,
  query,
  refresh,
  href,
  openRecord,
}: {
  projectId: string;
  query: string;
  refresh: number;
  href: (q?: Query) => string;
  openRecord: (id: string) => void;
}) {
  const router = useRouter(),
    [text, setText] = useState(query);
  const [cursor, setCursor] = useState<string | undefined>();
  useEffect(() => setCursor(undefined), [query]);
  const d = useResource<
    Page<{
      id: string;
      type: string;
      title: string;
      summary: string;
      state: string;
    }>
  >(
    projectId,
    query.trim() ? { view: "search", q: query, cursor } : null,
    refresh,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROJECT / SEARCH</p>
          <h1>{query ? `“${query}” 찾아보기` : "프로젝트에서 찾기"}</h1>
          <p className="lead">
            관련 주제와 생각, 작업, 지나온 변화를 함께 찾아요.
          </p>
        </div>
      </div>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim())
            router.push(href({ view: "search", q: text.trim() }));
        }}
      >
        <input
          aria-label="찾을 내용"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="주제나 기억나는 말"
        />
        <button className="button primary">찾기</button>
      </form>
      {d.error && <Failure>{d.error}</Failure>}
      {d.loading && <Loading />}
      {d.data?.items.map((r) =>
        r.type === "topic" ? (
          <Link
            key={r.id}
            className="search-result"
            href={href({ view: "topics", topic: r.id })}
          >
            <small>주제</small>
            <h3>{r.title}</h3>
            <p>{r.summary}</p>
          </Link>
        ) : (
          <button
            className="search-result"
            key={r.id}
            onClick={() => openRecord(r.id)}
          >
            <small>
              {labels[r.type]} · {labels[r.state]}
            </small>
            <h3>{r.title}</h3>
            <p>{r.summary}</p>
          </button>
        ),
      )}
      {d.data && !d.data.items.length && (
        <Empty>
          일치하는 기록이 없어요. 다른 단어나 주제 이름으로 찾아보세요.
        </Empty>
      )}
      {d.data && (
        <Pagination next={d.data.next_cursor} cursor={cursor} set={setCursor} />
      )}
    </>
  );
}

function Dialog({
  title,
  close,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "dialog wide-dialog" : "dialog"}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const box = ref.current.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <div className="dialog-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={close}>
          <X size={20} />
        </button>
      </div>
      <div className="dialog-content">{children}</div>
    </dialog>
  );
}
type RecordDetail = {
  record: Memory & { effective_state?: string };
  sources: SourceMeta[];
  related: { id: string; title: string; state: string }[];
  read_set: { topic_id: string; context_version: number }[];
};
function RecordDialog({
  projectId,
  id,
  refresh,
  close,
}: {
  projectId: string;
  id: string;
  refresh: number;
  close: () => void;
}) {
  const [localRefresh, setLocalRefresh] = useState(0);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const d = useResource<RecordDetail>(
    projectId,
    { view: "record", id },
    refresh + localRefresh,
  );
  const [handoff, setHandoff] = useState(false);
  return (
    <Dialog title={d.data?.record.title ?? "기록 읽기"} close={close} wide>
      {d.error ? (
        <Failure>{d.error}</Failure>
      ) : d.data ? (
        <>
          <Badge state={d.data.record.effective_state ?? d.data.record.state} />
          <p className="dialog-lead">{d.data.record.summary}</p>
          <Prose>{d.data.record.body}</Prose>
          {d.data.record.kind === 'work' && d.data.record.state === 'candidate' && (
            <div className="condition">
              <p>실행 전에 범위와 완료 조건을 확인해 주세요. 승인은 작업을 자동 실행하지 않아요.</p>
              <button className="button primary" disabled={approving} onClick={async () => {
                setApproving(true); setApprovalError('');
                try {
                  await request(projectId,{}, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'approve_candidate',operation_id:crypto.randomUUID(),work_id:id,expected_version:d.data!.record.version})});
                  setLocalRefresh(v=>v+1);
                } catch(error) {setApprovalError(error instanceof Error ? error.message : '승인하지 못했어요.');}
                finally {setApproving(false);}
              }}>{approving ? '승인 중…' : '이 범위의 후속 작업 승인'}</button>
              {approvalError && <Failure>{approvalError}</Failure>}
            </div>
          )}
          {d.data.record.kind === "context" && (
            <div className="condition">
              <strong>언제 다시 판단하나요?</strong>
              <p>{d.data.record.resolution}</p>
            </div>
          )}
          {d.data.record.acceptance && (
            <div className="condition">
              <strong>확인할 결과</strong>
              <Prose>{d.data.record.acceptance}</Prose>
            </div>
          )}
          {!!d.data.related.length && (
            <section>
              <h3>함께 읽을 기록</h3>
              {d.data.related.map((r) => (
                <p key={r.id}>
                  <span className="relation-label">
                    {d.data!.record.depends_on.includes(r.id)
                      ? "먼저 할 일"
                      : d.data!.record.derived_from.includes(r.id)
                        ? "여기서 시작한 생각"
                        : "상위 작업"}
                  </span>{" "}
                  {r.title} <Badge state={r.state} />
                </p>
              ))}
            </section>
          )}
          {d.data.record.kind === "event" && (
            <div className="condition">
              <strong>그 이유</strong>
              <p>{d.data.record.reason}</p>
              <small>{date(d.data.record.occurred_at, true, d.data.record.project_timezone)}</small>
              {d.data.record.activity_id && (
                <p><Link className="text-link" href={`/?${new URLSearchParams({ project: projectId, view: "activities", activity: d.data.record.activity_id })}`}>이 변화의 작업 결과 읽기</Link></p>
              )}
            </div>
          )}
          {!!d.data.record.evidence.length && (
            <section>
              <h3>확인한 범위</h3>
              {d.data.record.evidence.map((e, i) => (
                <p key={i}>
                  <strong>{labels[e.method]}</strong> · {e.scope}
                  <br />
                  <small>
                    {e.target} · {date(e.observed_at, true)}
                  </small>
                </p>
              ))}
            </section>
          )}
          {d.data.record.kind === "work" && (
            <div className="handoff-area">
              <button
                className="button primary"
                onClick={() => setHandoff(!handoff)}
              >
                <Copy size={15} /> ChatGPT에서 작업지시 이어가기
              </button>
              <p className="quiet">
                전달문을 다듬어 회사 Codex에 복사하고, 완료보고를 다시 가져와요.
              </p>
              {handoff && <Handoff projectId={projectId} id={id} />}
            </div>
          )}
          <details className="source-section">
            <summary>근거가 필요할 때 · 원문 {d.data.sources.length}개</summary>
            <Sources projectId={projectId} sources={d.data.sources} />
          </details>
          <Audit projectId={projectId} type="record" id={id} />
        </>
      ) : (
        <Loading />
      )}
    </Dialog>
  );
}
function Handoff({ projectId, id }: { projectId: string; id: string }) {
  const d = useResource<{
    text: string;
    recommendation?: Recommendation | null;
    ready: boolean;
    read_set: unknown;
    work_version: number;
    has_more: boolean;
    continuations: unknown[];
  }>(projectId, { view: "handoff", id });
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  if (d.error) return <Failure>{d.error}</Failure>;
  if (!d.data) return <Loading />;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `${d.data!.text}\n\n[Developlog 기준 — ChatGPT 결과 반영용]\n${JSON.stringify({ project_id: projectId, work_id: id, work_version: d.data!.work_version, read_set: d.data!.read_set, ...(d.data!.has_more ? { continuations: d.data!.continuations } : {}) })}`,
      );
      setCopied(true);
    } catch {
      setError("자동 복사가 안 돼요. 아래 전달문을 선택해서 복사해 주세요.");
    }
  };
  return (
    <div className="handoff">
      {!d.data.ready && (
        <p className="warning">
          먼저 대기 조건을 확인할 작업이에요. 바로 구현에 착수하는 지시로
          사용하지 않아요.
        </p>
      )}
      {d.data.has_more && (
        <p className="warning">
          긴 규칙 일부는 생략됐어요. 관련 주제를 함께 읽어 필요한 범위를 골라
          주세요.
        </p>
      )}
      <HandoffRecommendation recommendation={d.data.recommendation} />
      <textarea
        aria-label="작업 전달문"
        readOnly
        value={d.data.text}
        rows={12}
      />
      <button className="button" onClick={copy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "복사했어요" : "전달문과 기준 복사"}
      </button>
      {error && <Failure>{error}</Failure>}
      <details>
        <summary>결과를 반영할 때 사용할 기준</summary>
        <pre>
          {JSON.stringify(
            { work_version: d.data.work_version, read_set: d.data.read_set },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
function LazySection<T>({
  title,
  subtitle,
  projectId,
  query,
  render,
}: {
  title: string;
  subtitle?: string;
  projectId: string;
  query: Query;
  render: (data: T) => ReactNode;
}) {
  const [open, setOpen] = useState(false),
    d = useResource<T>(projectId, open ? query : null);
  return (
    <section className="lazy-section">
      <button
        className="lazy-trigger"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </span>
        {open ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
      </button>
      {open && (
        <div className="lazy-body">
          {d.error ? (
            <Failure>{d.error}</Failure>
          ) : d.data ? (
            render(d.data)
          ) : (
            <Loading />
          )}
        </div>
      )}
    </section>
  );
}
function Sources({
  projectId,
  sources,
}: {
  projectId: string;
  sources: SourceMeta[];
}) {
  return (
    <div className="sources">
      {sources.map((s) => (
        <SourceLink projectId={projectId} source={s} key={s.id} />
      ))}
      {!sources.length && <Empty>아직 연결된 원문이 없어요.</Empty>}
    </div>
  );
}
function SourceLink({
  projectId,
  source,
}: {
  projectId: string;
  source: SourceMeta;
}) {
  const [open, setOpen] = useState(false),
    [offset, setOffset] = useState(0);
  const d = useResource<
    SourceMeta & {
      body: string;
      next_offset: number | null;
      total_length: number;
    }
  >(projectId, open ? { view: "source", id: source.id, offset } : null);
  return (
    <div className="source-item">
      <button
        className="source-link"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setOffset(0);
        }}
      >
        <FileText size={14} />
        {source.title}
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="source-body">
          {source.captured_by && (
            <small>
              입력 주체 ·{" "}
              {source.captured_by === "ai" ? "AI가 옮긴 자료" : "사용자"}
            </small>
          )}
          {source.url && /^https?:\/\//.test(source.url) && (
            <a href={source.url} target="_blank" rel="noreferrer">
              원래 위치 열기 ↗
            </a>
          )}
          {source.ref && <small>대상 · {source.ref}</small>}
          {d.error ? (
            <Failure>{d.error}</Failure>
          ) : d.data ? (
            <>
              <pre>{d.data.body}</pre>
              <div className="pagination">
                {offset > 0 && (
                  <button
                    className="button"
                    onClick={() => setOffset(Math.max(0, offset - 8000))}
                  >
                    앞부분
                  </button>
                )}
                {d.data.next_offset !== null && (
                  <button
                    className="button"
                    onClick={() => setOffset(d.data!.next_offset!)}
                  >
                    원문 이어 읽기 <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </>
          ) : (
            <Loading />
          )}
        </div>
      )}
    </div>
  );
}
function Audit({
  projectId,
  type,
  id,
}: {
  projectId: string;
  type: string;
  id: string;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  return (
    <LazySection
      title="기록을 고친 이력"
      subtitle="필요할 때만 보는 이전 판본"
      projectId={projectId}
      query={{ view: "revisions", type, id, cursor }}
      render={(
        d: Page<{
          id: string;
          version: number;
          reason: string;
          created_at: string;
        }>,
      ) => (
        <>
          {d.items.map((r) => (
            <LazySection
              key={r.id}
              title={`${date(r.created_at, true)} · ${r.reason}`}
              projectId={projectId}
              query={{ view: "revision", id: r.id }}
              render={(s: unknown) => (
                <pre className="audit-snapshot">
                  {JSON.stringify(s, null, 2)}
                </pre>
              )}
            />
          ))}
          <Pagination next={d.next_cursor} cursor={cursor} set={setCursor} />
        </>
      )}
    />
  );
}
export function ProjectDialog({
  projectId,
  close,
}: {
  projectId: string;
  close: () => void;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const id = useRef(crypto.randomUUID());
  return (
    <Dialog title="새 프로젝트" close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const p = await request<Project>(
              projectId,
              {},
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "create_project",
                  project_id: id.current,
                  name,
                  description,
                }),
              },
            );
            window.location.href = `/?project=${p.id}`;
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          프로젝트 이름
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          어떤 프로젝트인가요? <small>선택</small>
          <textarea
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {error && <Failure>{error}</Failure>}
        <div className="dialog-actions">
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? "만드는 중…" : "프로젝트 시작"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

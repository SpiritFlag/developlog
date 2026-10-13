"use client";

import { useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { ArrowRight, BookOpen, Layers, Plus } from "lucide-react";
import { ProjectDialog } from "./workspace";
import type { Page, Project } from "@/lib/model";

export default function ProjectLibrary({
  projects,
  hasPrevious,
}: {
  projects: Page<Project>;
  hasPrevious: boolean;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="project-library">
      <header className="library-header">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <BookOpen size={21} />
          </span>
          <span>
            developlog<small>프로젝트를 이어 읽는 곳</small>
          </span>
        </Link>
        <UserButton />
      </header>
      <main className="library-main">
        <div className="library-heading">
          <div>
            <p className="eyebrow">YOUR PROJECTS</p>
            <h1>어느 프로젝트를 이어볼까요?</h1>
            <p className="lead">
              지금의 모습과 여기까지 온 이유, 프로젝트마다 이어져 있어요.
            </p>
          </div>
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={17} />새 프로젝트
          </button>
        </div>
        {projects.items.length ? (
          <div className="project-card-grid">
            {projects.items.map((project) => (
              <Link
                key={project.id}
                className="project-card"
                href={`/?project=${encodeURIComponent(project.id)}`}
              >
                <div className="project-card-top">
                  <span className="project-card-icon">
                    <Layers size={23} />
                  </span>
                  <ArrowRight size={20} />
                </div>
                <h2>{project.name}</h2>
                <p>
                  {project.description ||
                    "첫 주제와 생각을 남기며 프로젝트의 현재를 함께 정리해 보세요."}
                </p>
                <div className="project-card-bottom">
                  <span>현재 상황 읽기</span>
                  <time dateTime={new Date(project.updated_at).toISOString()}>
                    {new Date(project.updated_at).toLocaleDateString("ko-KR", {
                      timeZone: "Asia/Seoul",
                      month: "long",
                      day: "numeric",
                    })}{" "}
                    기록
                  </time>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="library-empty">
            <BookOpen size={34} />
            <h2>첫 프로젝트를 남겨볼까요?</h2>
            <p>이름부터 가볍게 시작하고, 생각과 현재 상황을 이어가요.</p>
            <button
              className="button primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={16} />
              프로젝트 만들기
            </button>
          </div>
        )}
        {(hasPrevious || projects.next_cursor) && (
          <nav className="pagination" aria-label="프로젝트 목록 페이지">
            {hasPrevious && (
              <Link className="button" href="/">
                처음으로
              </Link>
            )}
            {projects.next_cursor && (
              <Link
                className="button"
                href={`/?cursor=${encodeURIComponent(projects.next_cursor)}`}
              >
                다음 프로젝트 <ArrowRight size={15} />
              </Link>
            )}
          </nav>
        )}
        <footer className="page-footer">
          <span>developlog</span>
          <span>현재를 읽고, 이유를 남기고, 다음으로.</span>
        </footer>
      </main>
      {creating && (
        <ProjectDialog projectId="" close={() => setCreating(false)} />
      )}
    </div>
  );
}

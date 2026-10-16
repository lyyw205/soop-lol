/**
 * 자동화 등록부(ops/jobs/*.json)의 형식 — 등록부 읽기(scripts/ops/jobs.ts)와 운영 화면(model.ts)이 같이 쓴다.
 * 내용은 생성 파일 jobs.generated.ts(`node scripts/ops/jobs.ts sync`)에 있다. 손으로 고치지 않는다.
 */
import type { RoomId } from "./model.ts";

export const GROUPS = ["collect", "research", "maintenance", "ops", "experiment"] as const;
/** 설치 묶음. manual = 사람이 그때그때 띄움, none = 이 PC 에 설치하지 않음(루프 전용·실험). */
export const INSTALLS = ["default", "ck-auto", "schedule", "community", "t7-archive", "manual", "none"] as const;
export const RESOURCES = ["riot", "nexon", "fc-site", "soop-board", "soop-vod", "asr", "claude", "disk", "db"] as const;
/**
 * 실행 기록 방식(scripts/ops/run-job.ts).
 *   runner    — 감싸서 기록하고, 멈춘 이유는 실행기가 분기마다 남긴다(없으면 unknown).
 *   exit_code — 감싸서 기록하고, 이유는 종료 코드로 정한다(0 완료 · 신호 종료 · 그 외 오류). 성공 경로가 하나뿐인 단순 작업만.
 *   none      — 감싸지 않는다(상주 루프·실험·운영 오피스 자신).
 */
export const RECORDS = ["runner", "exit_code", "none"] as const;
export const ROOM_IDS = ["lol", "fc", "schedule", "community", "research", "backfill"] as const satisfies readonly RoomId[];

export interface RegistryJob {
  id: string;
  title: string;
  display_group?: string;
  group: (typeof GROUPS)[number];
  install: (typeof INSTALLS)[number];
  install_hook?: string;
  units: string[];
  run: string;
  schedule: string;
  record: (typeof RECORDS)[number];
  /** 운영 화면 카드. 없으면 화면에 따로 안 보인다(운영 DB 점검처럼 다른 칸이 보여 주는 것·관측자 자신). */
  office?: { room: RoomId; cadence: string; max_age_min?: number; max_run_min: number };
  locks: string[];
  resources: (typeof RESOURCES)[number][];
  skills?: string[];
  stop_files?: string[];
  publication?: string;
  critical?: boolean;
  /** 감싸기 이전·상주 루프가 job_run.job 에 남기는 엔진 이름 — 그 기록도 이 작업의 이력으로 읽는다. */
  job_run_names?: string[];
  docs: string[];
  notes?: string;
  remove: string[];
}

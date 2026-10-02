import { redirect } from "next/navigation";

/** 화면 경기 목록은 FC 맥락 검수 목록에 합쳐졌다(같은 표). 예전 주소는 거기로 보낸다. */
export default function FcoScreenListRedirect() {
  redirect("/admin/fco");
}

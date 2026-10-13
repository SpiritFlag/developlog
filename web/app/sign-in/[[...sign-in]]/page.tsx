import { SignIn } from "@clerk/nextjs";
import Image from "next/image";
export default function SignInPage() {
  return (
    <main className="auth-page">
      <section>
        <p className="eyebrow">DEVELOPLOG · 디벨롭로그</p>
        <h1>
          다시, 이야기의
          <br />
          다음 페이지로.
        </h1>
        <p>
          개발하면서 나눈 생각과 만들어온 이야기.
          <br />
          어제의 맥락에서 오늘의 작업을 이어가요.
        </p>
        <Image
          src="/developlog-profile.png"
          alt="개발자와 AI가 함께 이야기를 쓰는 Developlog"
          width={400}
          height={400}
          priority
        />
      </section>
      <SignIn forceRedirectUrl="/" />
    </main>
  );
}

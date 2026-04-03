import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const MAINTENANCE_MODE = true;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!MAINTENANCE_MODE) {
    return NextResponse.next();
  }

  const isAllowed =
    pathname === "/maintenance" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/_next");

  if (isAllowed) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/maintenance", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
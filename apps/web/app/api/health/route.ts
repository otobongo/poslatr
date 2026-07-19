import { NextResponse } from 'next/server';

// The only unauthenticated route in the app, per SECURITY.md 2.6 and PRD 5.1 item 5.
export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' });
}

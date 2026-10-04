// Fake "live browser" used only by mock mode (?mock=1) inside the LiveView iframe.
// Renders a simplified Lumen+ page for each step of the storyboard.
const PAGES: Record<number, { path: string; title: string; body: string; cta?: string; side?: boolean }> = {
  0: { path: '/', title: 'Stream what you love.', body: 'Thousands of films and series. One membership.', cta: 'Account' },
  1: { path: '/account', title: 'Welcome back, Ali', body: 'Your account at a glance.', side: true },
  2: { path: '/account/billing', title: 'Billing', body: 'Lumen+ Premium · $19/month · Renews tomorrow', cta: 'Manage membership', side: true },
  3: { path: '/account/membership', title: 'Lumen+ Premium', body: '$19/month · Next renewal: tomorrow', cta: 'Cancel membership', side: true },
  4: { path: '/account/membership/cancel', title: 'Before you go…', body: 'Get 50% off for the next 3 months.', cta: 'No thanks, continue to cancel' },
  5: { path: '/account/membership/cancel/confirm', title: 'Confirm cancellation', body: '$19/month · You’ll keep access until tomorrow.', cta: 'Confirm cancellation' },
  6: { path: '/account/membership?canceled=1', title: 'Membership canceled', body: 'Renews: No · Access ends tomorrow.', side: true },
  7: { path: '/account/membership?canceled=1', title: 'Membership canceled', body: 'Renews: No · Access ends tomorrow.', side: true },
};

export default async function MockLive({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  const p = PAGES[Number(step) || 0] ?? PAGES[0];
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', background: '#0f0e17', color: '#f4f2ff', minHeight: '100vh', fontSize: 14 }}>
      <div style={{ background: '#1c1b29', padding: '8px 14px', color: '#9a97b3', fontSize: 12 }}>lumen-plus.demo{p.path}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderBottom: '1px solid #27253a' }}>
        <strong style={{ fontSize: 18, letterSpacing: '-0.02em' }}>
          Lumen<span style={{ color: '#a78bfa' }}>+</span>
        </strong>
        <span style={{ color: '#9a97b3' }}>Account</span>
      </div>
      <div style={{ display: 'flex', gap: 24, padding: 24 }}>
        {p.side && (
          <div style={{ width: 120, display: 'flex', flexDirection: 'column', gap: 10, color: '#9a97b3' }}>
            <span>Overview</span>
            <span>Profile</span>
            <span style={{ color: p.path.includes('billing') ? '#fff' : undefined }}>Billing</span>
            <span>Devices</span>
          </div>
        )}
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>{p.title}</h1>
          <p style={{ color: '#c4c1dc', marginTop: 8 }}>{p.body}</p>
          {p.cta && (
            <span
              style={{
                display: 'inline-block',
                marginTop: 18,
                padding: '10px 18px',
                borderRadius: 999,
                background: '#a78bfa',
                color: '#0f0e17',
                fontWeight: 600,
                boxShadow: '0 0 0 4px rgba(167,139,250,0.35)',
              }}
            >
              {p.cta}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

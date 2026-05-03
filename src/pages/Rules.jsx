export default function Rules() {
  return (
    <div className="px-4 pt-6 space-y-4">
      <div>
        <h1 className="text-white text-xl font-bold tracking-tight mb-1">Rules</h1>
        <p className="text-subtle text-xs">
          The non-negotiables. Encoded in the pre-trade checklist and stop-loss UI.
        </p>
      </div>

      <Section title="Entry">
        <Row>Minimum 2 confirmed signals before logging</Row>
        <Row>Never enter when stock is at all-time highs</Row>
        <Row>Never enter under 21 DTE</Row>
        <Row>30–45 days before known catalyst</Row>
        <Row>90–120 days for fuzzy timelines</Row>
      </Section>

      <Section title="Position Sizing">
        <Row>
          <span className="text-white">2%</span> of account per options trade
        </Row>
        <Row>
          <span className="text-white">1%</span> of account per Kalshi trade
        </Row>
        <Row>
          <span className="text-white">20%</span> max biotech sector exposure
        </Row>
      </Section>

      <Section title="Stop Loss">
        <Row>
          Option down <span className="text-red-400">-50%</span> → exit immediately
        </Row>
        <Row>Thesis invalidated by new data → exit same day</Row>
      </Section>

      <Section title="Profit Taking">
        <Row>
          <span className="text-green-400">+100%</span> → sell 50% of position
        </Row>
        <Row>
          <span className="text-green-400">+200%</span> → sell 75% of position
        </Row>
        <Row>Day before catalyst → consider full exit</Row>
        <Row>Sell into IV spike, not after announcement</Row>
      </Section>

      <Section title="Strike Calculator">
        <Row>Never pay more than 40% of spread width in premium</Row>
        <Row>Minimum 1:1.5 risk/reward — target 1:2</Row>
        <Row>Always buy expiry 30–45 days PAST the catalyst date</Row>
      </Section>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="space-y-2 text-xs text-zinc-400">{children}</div>
    </div>
  )
}

function Row({ children }) {
  return <p>• {children}</p>
}

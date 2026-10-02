import { Calculator } from 'lucide-react'

// /simulator — after-tax "what if" sandbox (Pro). Placeholder until the
// simulator lands: change state of residence, filing status, income,
// holding period and exit value to compare after-tax outcomes.
export default function Simulator() {
  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <Calculator size={16} className="text-amber-400" />
        <h1 className="text-lg font-semibold">Simulator</h1>
      </div>
      <p className="text-xs text-subtle leading-relaxed">
        Coming soon: change your state, filing status, income and timing to see how much of a LEAPS gain you
        keep after tax.
      </p>
    </div>
  )
}

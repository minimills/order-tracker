import { CustomColourButton } from '../colour/CustomColour'

/** A row of colour swatches (boards and labels) and "+" for any other colour. */
/* @layout-helper */
export default function ColourPicker({ colours, value, onChange, label }: { colours: string[]; value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {colours.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c.toLowerCase()}
          aria-label={c}
          onClick={() => onChange(c)}
          className={`h-7 w-7 rounded-full ring-offset-2 ${value.toLowerCase() === c.toLowerCase() ? 'ring-2 ring-slate-900' : 'ring-1 ring-black/10'}`}
          style={{ backgroundColor: c }}
        />
      ))}
      <CustomColourButton value={value} presets={colours} onChange={onChange} label={label} />
    </div>
  )
}

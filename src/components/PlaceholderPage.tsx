type Props = {
  title: string
  description: string
}

/** Simple page shell used until each page is built. */
export default function PlaceholderPage({ title, description }: Props) {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-slate-600">{description}</p>
      <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
        This feature will be available in a future update.
      </div>
    </div>
  )
}

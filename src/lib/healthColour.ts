import { createContext } from 'react'

/** The good / bad colour of a widget frame (number widgets draw their number in it); null = the widget's own colour. */
export const HealthColour = createContext<string | null>(null)

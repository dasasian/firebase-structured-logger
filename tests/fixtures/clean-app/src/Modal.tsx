import type { ReactNode } from 'react'

export function Modal({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div role="dialog" className="modal" data-fsl-view={name}>
      {children}
    </div>
  )
}

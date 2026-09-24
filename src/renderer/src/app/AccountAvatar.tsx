import { useState } from 'react'

export function AccountAvatar({ avatarUrl, displayName }: { avatarUrl?: string | null; displayName?: string }): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const imageUrl = avatarUrl?.startsWith('https://') ? avatarUrl : null
  const showImage = imageUrl !== null && failedUrl !== imageUrl

  return <span className="account-avatar" aria-hidden="true">
    {showImage ? <img src={imageUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(imageUrl)} /> : <span>{displayName?.trim().slice(0, 1) || '钉'}</span>}
  </span>
}

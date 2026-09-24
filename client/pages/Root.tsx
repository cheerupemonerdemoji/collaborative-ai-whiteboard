import { Navigate } from 'react-router-dom'

export function Root() {
	return <Navigate to="/boards" replace />
}

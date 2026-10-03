import { type RouteObject } from 'react-router-dom'
import { RequireAuth } from './auth'
import { HelpPage } from './help/HelpPage'
import { Dashboard } from './pages/Dashboard'
import { Login } from './pages/Login'
import { Room } from './pages/Room'
import { Root } from './pages/Root'

export const appRoutes: RouteObject[] = [
	{
		path: '/login',
		element: <Login />,
	},
	// Public product documentation: no board data and no authentication needed. Declared outside
	// RequireAuth, and distinct from the legacy /:roomId catch-all below, so /help is never a room.
	{ path: '/help', element: <HelpPage /> },
	{ path: '/help/:slug', element: <HelpPage /> },
	{ path: '/help/*', element: <HelpPage /> },
	{
		element: <RequireAuth />,
		children: [
			{ path: '/', element: <Root /> },
			{ path: '/boards', element: <Dashboard /> },
			{ path: '/room/:roomId', element: <Room /> },
			// Keep old shared room links working while moving canonical URLs under /room/.
			{ path: '/:roomId', element: <Room /> },
		],
	},
]

import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthProvider, RequireAuth } from './auth'
import { Dashboard } from './pages/Dashboard'
import { Login } from './pages/Login'
import { Room } from './pages/Room'
import { Root } from './pages/Root'

const router = createBrowserRouter([
	{
		path: '/login',
		element: <Login />,
	},
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
])

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<AuthProvider>
			<RouterProvider router={router} />
		</AuthProvider>
	</React.StrictMode>
)

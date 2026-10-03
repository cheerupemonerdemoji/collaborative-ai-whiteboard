import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthProvider } from './auth'
import { appRoutes } from './routes'

const router = createBrowserRouter(appRoutes)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<AuthProvider>
			<RouterProvider router={router} />
		</AuthProvider>
	</React.StrictMode>
)

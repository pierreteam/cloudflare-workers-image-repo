const DefaultTarget = 'https://registry-1.docker.io';

/** @type {Table} */
const Routes = {
	docker: 'https://registry-1.docker.io',
	k8s: 'https://registry.k8s.io',
	gcr: 'https://gcr.io',
	ghcr: 'https://ghcr.io',
	quay: 'https://quay.io',
	nvcr: 'https://nvcr.io',
	ecr: 'https://public.ecr.aws',
};

export default {
	/**
	 * 应用入口
	 * @param {Request} req
	 * @param {Env} env
	 * @returns
	 */
	async fetch(req, env) {
		const url = new URL(req.url);

		// 路由决策
		const target = routing(url, env);

		// 规范化路径
		const path = url.pathname.replace(/\/{2,}/g, '/');

		if (!path || path === '/')
			return new Response(JSON.stringify(req.cf, null, 4), { status: 200, headers: { 'content-type': 'application/json' } });

		// 授权接口路径
		const AuthPath = '/v2/auth/'; // Must end with '/'

		// 创建转发请求头
		const headers = new Headers();
		copyHeaders(req.headers, headers, 'Content-Type', 'Content-Length');
		copyHeaders(req.headers, headers, 'Accept', 'Accept-Language', 'Accept-Encoding');
		copyHeaders(req.headers, headers, 'Authorization', 'User-Agent');

		// 处理授权请求
		if (path.startsWith(AuthPath)) {
			// 从 URL 中获取认证服务
			const realm = decodeURIComponent(path.slice(AuthPath.length));

			if (!realm) return new Response('Not Found Auth Service', { status: 404 });

			// 转发授权请求
			return await fetch(`${realm}${url.search}`, {
				redirect: 'follow',
				headers: headers,
				method: req.method,
				body: req.body,
			});
		}

		// 处理资源请求
		copyHeaders(req.headers, headers, 'Range', 'If-Range'); // 断点续传控制
		copyHeaders(req.headers, headers, 'If-None-Match', 'If-Modified-Since'); // 协商缓存控制
		copyHeaders(req.headers, headers, 'Cache-Control'); // 强制缓存控制

		// 转发资源请求
		const resp = await fetch(`${target}${url.pathname}${url.search}`, {
			redirect: 'manual', // 禁用自动重定向，需要特殊处理
			headers: headers,
			method: req.method,
			body: req.body,
		});

		// 处理授权响应
		if (resp.status === 401 && !yes(env.DisableProxyAuth)) {
			const realm = `${url.protocol}//${url.host}${AuthPath}`;

			const headers = new Headers(resp.headers);
			replaceAuthService(headers, realm);

			return new Response(resp.body, {
				headers: headers,
				status: resp.status,
				statusText: resp.statusText,
			});
		}

		// 处理重定向
		if (resp.headers.has('Location')) {
			const location = resp.headers.get('Location');
			if (!location) return resp;

			// fix s3 error: "InvalidRequest: Missing x-amz-content-sha256"
			headers.delete('Authorization');

			return fetch(location, {
				redirect: 'follow',
				headers: headers,
				method: req.method,
				body: req.body,
			});
		}

		return resp;
	},
};

/**
 * 复制响应头
 * @param {Headers} src
 * @param {Headers} dst
 * @param {...string} keys
 * @returns
 */
function copyHeaders(src, dst, ...keys) {
	for (const key of keys) {
		if (src.has(key)) {
			dst.set(key, src.get(key) || '');
		}
	}
}

/**
 * 路由决策
 * @param {URL} url
 * @param {Env} env
 * @returns {string|null}
 */
function routing(url, env) {
	let target;

	// 前缀路由
	if (!yes(env.DisablePrefixRoute)) {
		target = url.hostname.slice(0, url.hostname.indexOf('.'));
		target = Routes[target.toLowerCase()];
		if (target) return target;
	}

	// 默认配置
	return env.Target || DefaultTarget || null;
}

/**
 * 替换认证服务
 * @param {Headers} headers - 待修改的响应头
 * @param {string} realm - realm 地址
 */
function replaceAuthService(headers, realm) {
	let header = headers.get('WWW-Authenticate');
	if (header) {
		// realm="auth_api" => realm="custom_auth_api/auth_api"
		header = header.replace(/(realm=)"([^"]*)"/i, (_, prefix, value) => {
			const separator = realm.endsWith('/') ? '' : '/';
			return `${prefix}"${realm}${separator}${encodeURIComponent(value)}"`;
		});
		headers.set('WWW-Authenticate', header);
	}
}

/*********************************************************************/
// 辅助函数

/**
 * @param {string|undefined} value
 * @returns
 */
function yes(value) {
	if (!value) return false;
	const val = value.toLowerCase();
	return !!val && val !== 'no' && val !== 'false' && val !== '0';
}

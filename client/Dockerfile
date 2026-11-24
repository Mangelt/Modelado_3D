FROM nginx:1.27-alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY client/index.html /usr/share/nginx/html/index.html
COPY client/app.js /usr/share/nginx/html/app.js
EXPOSE 80

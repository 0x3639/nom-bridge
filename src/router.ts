import {createRouter, createWebHistory} from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('@/pages/Bridge.vue') },
    { path: '/requests', component: () => import('@/pages/Requests.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
